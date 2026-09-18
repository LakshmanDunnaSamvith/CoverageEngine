using System.Text.Json;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);
// Port 5070 is used deliberately: Chromium browsers block 5060/5061 (SIP) as unsafe ports.
builder.WebHost.UseUrls("http://0.0.0.0:5070", "http://[::]:5070");
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
var app = builder.Build();
app.UseCors();
app.MapMethods("/api/{*path}", ["OPTIONS"], () => Results.Ok());
var dataDirectory = Path.Combine(builder.Environment.ContentRootPath, "data");
var inventoryDirectory = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "01-module-inventory"));
var appsDirectory = Path.Combine(inventoryDirectory, "apps");
var defaultInventoryPath = Path.Combine(inventoryDirectory, "module_inventory.json");
var workflowOverlayPath = Path.Combine(inventoryDirectory, "workflows.overlay.json");
var crawlerDirectory = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "06-inventory-crawler"));
var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
var gate = new object();

// Turn a base URL into a filesystem-safe slug so each onboarded app gets its
// own inventory file under 01-module-inventory/apps/<slug>.json.
static string SlugForUrl(string baseUrl)
{
    var normalized = (baseUrl ?? "").Trim().ToLowerInvariant();
    if (Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
        normalized = uri.Host + (uri.IsDefaultPort ? "" : $"-{uri.Port}") + uri.AbsolutePath.TrimEnd('/');
    var slug = System.Text.RegularExpressions.Regex.Replace(normalized, "[^a-z0-9]+", "-").Trim('-');
    return string.IsNullOrEmpty(slug) ? "default" : slug;
}

// Resolve which inventory file backs a given base URL. Falls back to the
// legacy single-file inventory when no baseUrl is supplied.
string InventoryPathFor(string? baseUrl)
{
    if (string.IsNullOrWhiteSpace(baseUrl))
        return defaultInventoryPath;
    return Path.Combine(appsDirectory, $"{SlugForUrl(baseUrl)}.json");
}

T? Read<T>(string file) { var path = Path.Combine(dataDirectory, file); return File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), options) : default; }
void Write<T>(string file, T value) { Directory.CreateDirectory(dataDirectory); File.WriteAllText(Path.Combine(dataDirectory, file), JsonSerializer.Serialize(value, options)); }
List<CoverageSession> Sessions() => Read<List<CoverageSession>>("sessions.json") ?? [];
List<CoverageEvent> Events() => Read<List<CoverageEvent>>("events.json") ?? [];

// The crawler regenerates the inventory and cannot infer business workflows,
// so it emits an empty "workflows" list. Curated workflows live in
// workflows.overlay.json and are merged in here (by id) so a re-crawl never
// wipes them. Pass a baseUrl to select a specific onboarded app's inventory.
JsonElement Inventory(string? baseUrl = null)
{
    var path = ResolveInventoryPath(baseUrl);
    if (path is null)
        throw new FileNotFoundException(
            "No inventory available. Crawl an application first (POST /api/inventory/crawl).");
    return MergeWorkflowOverlay(File.ReadAllText(path), workflowOverlayPath, options);
}

// Resolve which inventory file to serve, dynamically:
//   1. The per-URL file for an explicit baseUrl, if it exists.
//   2. The legacy single-file module_inventory.json, if present.
//   3. The most recently crawled apps/<slug>.json (dynamic fallback) so the
//      bare endpoint and coverage reports work without a hard-coded baseUrl.
// Returns null when no inventory exists anywhere.
string? ResolveInventoryPath(string? baseUrl)
{
    if (!string.IsNullOrWhiteSpace(baseUrl))
    {
        var perUrl = InventoryPathFor(baseUrl);
        if (File.Exists(perUrl))
            return perUrl;
    }
    if (File.Exists(defaultInventoryPath))
        return defaultInventoryPath;
    return LatestAppInventoryPath();
}

// Most recently modified apps/<slug>.json, or null if none exist.
string? LatestAppInventoryPath()
{
    if (!Directory.Exists(appsDirectory))
        return null;
    return Directory.EnumerateFiles(appsDirectory, "*.json")
        .Select(f => new FileInfo(f))
        .OrderByDescending(f => f.LastWriteTimeUtc)
        .Select(f => f.FullName)
        .FirstOrDefault();
}

static JsonElement MergeWorkflowOverlay(string inventoryJson, string overlayPath, JsonSerializerOptions options)
{
    var inventory = JsonSerializer.Deserialize<JsonElement>(inventoryJson, options);
    if (!File.Exists(overlayPath))
        return inventory;

    var overlay = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(overlayPath), options);
    if (!overlay.TryGetProperty("workflows", out var overlayWorkflows) || overlayWorkflows.ValueKind != JsonValueKind.Array)
        return inventory;
    if (!inventory.TryGetProperty("application", out var application) || application.ValueKind != JsonValueKind.Object)
        return inventory;

    // Upsert by workflow id: overlay wins over any crawled placeholder.
    var merged = new Dictionary<string, JsonElement>();
    if (application.TryGetProperty("workflows", out var existing) && existing.ValueKind == JsonValueKind.Array)
        foreach (var wf in existing.EnumerateArray())
            if (wf.TryGetProperty("id", out var id) && id.GetString() is { } key)
                merged[key] = wf;
    foreach (var wf in overlayWorkflows.EnumerateArray())
        if (wf.TryGetProperty("id", out var id) && id.GetString() is { } key)
            merged[key] = wf;

    // Rebuild the application object with the merged workflows array, preserving
    // every other property (routes, id, name, baseUrl, ...) exactly as-is.
    var appOut = new Dictionary<string, object?>();
    foreach (var prop in application.EnumerateObject())
        if (prop.Name != "workflows")
            appOut[prop.Name] = prop.Value;
    appOut["workflows"] = merged.Values;

    var result = new Dictionary<string, object?> { ["application"] = appOut };
    return JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(result, options), options);
}

app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", service = "Coverage Intelligence API" }));
app.MapGet("/api/inventory", (string? baseUrl) =>
{
    try { return Results.Ok(Inventory(baseUrl)); }
    catch (FileNotFoundException ex) { return Results.Json(new { error = ex.Message }, statusCode: 404); }
});

// Does an inventory already exist for this base URL? Drives the dashboard's
// "onboard any URL" flow: if false, the UI enables the Crawl button.
app.MapGet("/api/inventory/status", (string baseUrl) =>
{
    if (string.IsNullOrWhiteSpace(baseUrl))
        return Results.BadRequest(new { error = "baseUrl is required" });
    var path = InventoryPathFor(baseUrl);
    var exists = File.Exists(path);
    int routes = 0, actions = 0;
    if (exists)
    {
        try
        {
            var inv = MergeWorkflowOverlay(File.ReadAllText(path), workflowOverlayPath, options);
            var routeArr = inv.GetProperty("application").GetProperty("routes");
            routes = routeArr.GetArrayLength();
            actions = routeArr.EnumerateArray()
                .SelectMany(r => r.GetProperty("components").EnumerateArray())
                .Sum(c => c.GetProperty("actions").GetArrayLength());
        }
        catch { exists = false; }
    }
    return Results.Ok(new { baseUrl, slug = SlugForUrl(baseUrl), exists, routes, actions });
});

// Trigger the Python crawler for an arbitrary base URL. Writes the inventory to
// 01-module-inventory/apps/<slug>.json so multiple apps can coexist.
app.MapPost("/api/inventory/crawl", async (CrawlRequest request) =>
{
    if (string.IsNullOrWhiteSpace(request.BaseUrl))
        return Results.BadRequest(new { error = "baseUrl is required" });

    var slug = SlugForUrl(request.BaseUrl);
    var outPath = Path.Combine(appsDirectory, $"{slug}.json");
    Directory.CreateDirectory(appsDirectory);

    // Prefer the crawler's venv python; fall back to python on PATH.
    var venvPython = Path.Combine(crawlerDirectory, ".venv", "Scripts", "python.exe");
    var pythonExe = File.Exists(venvPython) ? venvPython : (OperatingSystem.IsWindows() ? "python" : "python3");

    var psi = new System.Diagnostics.ProcessStartInfo
    {
        FileName = pythonExe,
        WorkingDirectory = crawlerDirectory,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
    };
    psi.ArgumentList.Add("crawl.py");
    psi.ArgumentList.Add("--base-url"); psi.ArgumentList.Add(request.BaseUrl);
    psi.ArgumentList.Add("--app-id"); psi.ArgumentList.Add(slug);
    psi.ArgumentList.Add("--out"); psi.ArgumentList.Add(outPath);
    if (!string.IsNullOrWhiteSpace(request.Name)) { psi.ArgumentList.Add("--name"); psi.ArgumentList.Add(request.Name); }
    if (!string.IsNullOrWhiteSpace(request.Username)) { psi.ArgumentList.Add("--username"); psi.ArgumentList.Add(request.Username); }
    if (!string.IsNullOrWhiteSpace(request.Password)) { psi.ArgumentList.Add("--password"); psi.ArgumentList.Add(request.Password); }
    if (!string.IsNullOrWhiteSpace(request.LoginPath)) { psi.ArgumentList.Add("--login-path"); psi.ArgumentList.Add(request.LoginPath); }
    if (!string.IsNullOrWhiteSpace(request.UsernameSelector)) { psi.ArgumentList.Add("--username-selector"); psi.ArgumentList.Add(request.UsernameSelector); }
    if (!string.IsNullOrWhiteSpace(request.PasswordSelector)) { psi.ArgumentList.Add("--password-selector"); psi.ArgumentList.Add(request.PasswordSelector); }
    if (!string.IsNullOrWhiteSpace(request.SubmitSelector)) { psi.ArgumentList.Add("--submit-selector"); psi.ArgumentList.Add(request.SubmitSelector); }
    if (!string.IsNullOrWhiteSpace(request.ReadySelector)) { psi.ArgumentList.Add("--ready-selector"); psi.ArgumentList.Add(request.ReadySelector); }
    if (string.IsNullOrWhiteSpace(request.Username) && string.IsNullOrWhiteSpace(request.Password)) psi.ArgumentList.Add("--no-auth");

    try
    {
        using var proc = System.Diagnostics.Process.Start(psi)!;
        var stdout = await proc.StandardOutput.ReadToEndAsync();
        var stderr = await proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync();
        if (proc.ExitCode != 0 || !File.Exists(outPath))
            return Results.Json(new { ok = false, exitCode = proc.ExitCode, stdout, stderr }, statusCode: 500);

        var inv = MergeWorkflowOverlay(File.ReadAllText(outPath), workflowOverlayPath, options);
        var routeArr = inv.GetProperty("application").GetProperty("routes");
        var routes = routeArr.GetArrayLength();
        var actions = routeArr.EnumerateArray()
            .SelectMany(r => r.GetProperty("components").EnumerateArray())
            .Sum(c => c.GetProperty("actions").GetArrayLength());
        return Results.Ok(new { ok = true, baseUrl = request.BaseUrl, slug, routes, actions, log = stdout });
    }
    catch (Exception ex)
    {
        return Results.Json(new { ok = false, error = ex.Message }, statusCode: 500);
    }
});

app.MapGet("/api/sessions", () => Results.Ok(Sessions().OrderByDescending(x => x.StartedAt)));
app.MapPost("/api/sessions", (StartSession request) => { lock (gate) { var session = new CoverageSession($"S-{Guid.NewGuid():N}"[..10].ToUpperInvariant(), request.Name ?? "Browser automation", "active", DateTimeOffset.UtcNow, null, 0, string.IsNullOrWhiteSpace(request.BaseUrl) ? null : request.BaseUrl.Trim()); var all = Sessions(); all.Add(session); Write("sessions.json", all); return Results.Ok(session); } });
app.MapGet("/api/sessions/{id}", (string id) => { var session = Sessions().FirstOrDefault(x => x.Id == id); return session is null ? Results.NotFound() : Results.Ok(new { session, events = Events().Where(x => x.SessionId == id) }); });
app.MapPost("/api/sessions/{id}/events", (string id, EventBatch batch) => { lock (gate) { var all = Events(); all.AddRange(batch.Events.Select(x => x with { SessionId = id })); Write("events.json", all); UpdateSession(id, batch.Events.Count, "active"); return Results.Accepted(); } });
app.MapPost("/api/sessions/{id}/checkpoint", (string id, Checkpoint checkpoint) => { lock (gate) { Write($"checkpoint-{id}.json", checkpoint with { SessionId = id }); UpdateSession(id, 0, "interrupted"); return Results.Ok(checkpoint); } });
app.MapPost("/api/sessions/{id}/stop", (string id) => { lock (gate) { UpdateSession(id, 0, "completed"); var session = Sessions().First(x => x.Id == id); return Results.Ok(new { session, report = BuildReport(session) }); } });
app.MapGet("/api/sessions/{id}/report", (string id) => { var session = Sessions().FirstOrDefault(x => x.Id == id); return session is null ? Results.NotFound() : Results.Ok(BuildReport(session)); });

void UpdateSession(string id, int added, string status) { var all = Sessions(); var index = all.FindIndex(x => x.Id == id); if (index < 0) return; all[index] = all[index] with { Status = status, EventCount = all[index].EventCount + added, StoppedAt = status == "completed" ? DateTimeOffset.UtcNow : all[index].StoppedAt }; Write("sessions.json", all); }
object BuildReport(CoverageSession session) { JsonElement inventory; try { inventory = Inventory(session.BaseUrl); } catch (FileNotFoundException) { var noInv = Events().Where(x => x.SessionId == session.Id).ToList(); return new { session, overall = new { expected = 0, covered = 0, missed = 0 }, routes = new { expected = 0, covered = 0, missed = Array.Empty<string>() }, actions = new { expected = 0, covered = 0, missed = Array.Empty<string>() }, eventCount = noInv.Count, warning = "No inventory available for this session. Crawl the application to enable coverage." }; } var events = Events().Where(x => x.SessionId == session.Id).ToList(); var routeIds = inventory.GetProperty("application").GetProperty("routes").EnumerateArray().Select(x => x.GetProperty("id").GetString()!).ToList(); var actionIds = inventory.GetProperty("application").GetProperty("routes").EnumerateArray().SelectMany(x => x.GetProperty("components").EnumerateArray()).SelectMany(x => x.GetProperty("actions").EnumerateArray()).Select(x => x.GetProperty("id").GetString()!).ToList(); var coveredRoutes = events.Where(x => x.RouteId is not null).Select(x => x.RouteId).Distinct().ToHashSet(); var coveredActions = events.Where(x => x.ActionId is not null).Select(x => x.ActionId).Distinct().ToHashSet(); return new { session, overall = new { expected = routeIds.Count + actionIds.Count, covered = coveredRoutes.Count + coveredActions.Count, missed = routeIds.Count - coveredRoutes.Count + actionIds.Count - coveredActions.Count }, routes = new { expected = routeIds.Count, covered = coveredRoutes.Count, missed = routeIds.Except(coveredRoutes).ToArray() }, actions = new { expected = actionIds.Count, covered = coveredActions.Count, missed = actionIds.Except(coveredActions).ToArray() }, eventCount = events.Count }; }
app.Run();

record StartSession(string? Name, string? BaseUrl);
record CrawlRequest(string BaseUrl, string? Name, string? Username, string? Password, string? LoginPath, string? UsernameSelector, string? PasswordSelector, string? SubmitSelector, string? ReadySelector);
record EventBatch(List<CoverageEvent> Events);
record CoverageEvent(string? SessionId, string EventId, string Kind, string? RouteId, string? ComponentId, string? ActionId, List<string>? WorkflowIds, string Source, DateTimeOffset Timestamp, Dictionary<string, string>? Metadata);
record Checkpoint(string SessionId, string LastEventId, string RouteId, string? ActionId, DateTimeOffset Timestamp, string Reason);
record CoverageSession(string Id, string Name, string Status, DateTimeOffset StartedAt, DateTimeOffset? StoppedAt, int EventCount, string? BaseUrl = null);
