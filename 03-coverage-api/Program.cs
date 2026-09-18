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
var inventoryPath = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "01-module-inventory", "module_inventory.json"));
var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
var gate = new object();

T? Read<T>(string file) { var path = Path.Combine(dataDirectory, file); return File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), options) : default; }
void Write<T>(string file, T value) { Directory.CreateDirectory(dataDirectory); File.WriteAllText(Path.Combine(dataDirectory, file), JsonSerializer.Serialize(value, options)); }
List<CoverageSession> Sessions() => Read<List<CoverageSession>>("sessions.json") ?? [];
List<CoverageEvent> Events() => Read<List<CoverageEvent>>("events.json") ?? [];
JsonElement Inventory() => JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(inventoryPath), options);

app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", service = "Coverage Intelligence API" }));
app.MapGet("/api/inventory", () => Results.Ok(Inventory()));
app.MapGet("/api/sessions", () => Results.Ok(Sessions().OrderByDescending(x => x.StartedAt)));
app.MapPost("/api/sessions", (StartSession request) => { lock (gate) { var session = new CoverageSession($"S-{Guid.NewGuid():N}"[..10].ToUpperInvariant(), request.Name ?? "Browser automation", "active", DateTimeOffset.UtcNow, null, 0); var all = Sessions(); all.Add(session); Write("sessions.json", all); return Results.Ok(session); } });
app.MapGet("/api/sessions/{id}", (string id) => { var session = Sessions().FirstOrDefault(x => x.Id == id); return session is null ? Results.NotFound() : Results.Ok(new { session, events = Events().Where(x => x.SessionId == id) }); });
app.MapPost("/api/sessions/{id}/events", (string id, EventBatch batch) => { lock (gate) { var all = Events(); all.AddRange(batch.Events.Select(x => x with { SessionId = id })); Write("events.json", all); UpdateSession(id, batch.Events.Count, "active"); return Results.Accepted(); } });
app.MapPost("/api/sessions/{id}/checkpoint", (string id, Checkpoint checkpoint) => { lock (gate) { Write($"checkpoint-{id}.json", checkpoint with { SessionId = id }); UpdateSession(id, 0, "interrupted"); return Results.Ok(checkpoint); } });
app.MapPost("/api/sessions/{id}/stop", (string id) => { lock (gate) { UpdateSession(id, 0, "completed"); var session = Sessions().First(x => x.Id == id); return Results.Ok(new { session, report = BuildReport(session) }); } });
app.MapGet("/api/sessions/{id}/report", (string id) => { var session = Sessions().FirstOrDefault(x => x.Id == id); return session is null ? Results.NotFound() : Results.Ok(BuildReport(session)); });

void UpdateSession(string id, int added, string status) { var all = Sessions(); var index = all.FindIndex(x => x.Id == id); if (index < 0) return; all[index] = all[index] with { Status = status, EventCount = all[index].EventCount + added, StoppedAt = status == "completed" ? DateTimeOffset.UtcNow : all[index].StoppedAt }; Write("sessions.json", all); }
object BuildReport(CoverageSession session) { var inventory = Inventory(); var events = Events().Where(x => x.SessionId == session.Id).ToList(); var routeIds = inventory.GetProperty("application").GetProperty("routes").EnumerateArray().Select(x => x.GetProperty("id").GetString()!).ToList(); var actionIds = inventory.GetProperty("application").GetProperty("routes").EnumerateArray().SelectMany(x => x.GetProperty("components").EnumerateArray()).SelectMany(x => x.GetProperty("actions").EnumerateArray()).Select(x => x.GetProperty("id").GetString()!).ToList(); var coveredRoutes = events.Where(x => x.RouteId is not null).Select(x => x.RouteId).Distinct().ToHashSet(); var coveredActions = events.Where(x => x.ActionId is not null).Select(x => x.ActionId).Distinct().ToHashSet(); return new { session, overall = new { expected = routeIds.Count + actionIds.Count, covered = coveredRoutes.Count + coveredActions.Count, missed = routeIds.Count - coveredRoutes.Count + actionIds.Count - coveredActions.Count }, routes = new { expected = routeIds.Count, covered = coveredRoutes.Count, missed = routeIds.Except(coveredRoutes).ToArray() }, actions = new { expected = actionIds.Count, covered = coveredActions.Count, missed = actionIds.Except(coveredActions).ToArray() }, eventCount = events.Count }; }
app.Run();

record StartSession(string? Name);
record EventBatch(List<CoverageEvent> Events);
record CoverageEvent(string? SessionId, string EventId, string Kind, string? RouteId, string? ComponentId, string? ActionId, List<string>? WorkflowIds, string Source, DateTimeOffset Timestamp, Dictionary<string, string>? Metadata);
record Checkpoint(string SessionId, string LastEventId, string RouteId, string? ActionId, DateTimeOffset Timestamp, string Reason);
record CoverageSession(string Id, string Name, string Status, DateTimeOffset StartedAt, DateTimeOffset? StoppedAt, int EventCount);
