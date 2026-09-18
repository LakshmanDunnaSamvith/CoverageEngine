"""Dynamic inventory crawler.

Drives any hosted web application in a real browser (Playwright), discovers
routes and interactive elements, and emits an inventory JSON in the exact
schema consumed by `02-coverage-engine/coverage_engine.py` and the .NET API.

Usage:
    python crawl.py --config crawl.config.json --out ../01-module-inventory/module_inventory.json

The crawler is application-agnostic: everything app-specific lives in the
config file (base URL, login steps, navigation selectors, dynamic-segment
patterns, risk rules).
"""
from __future__ import annotations

import argparse
import json
import re
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, TimeoutError as PWTimeout, sync_playwright

import fingerprint as fp

HERE = Path(__file__).parent
EXTRACT_JS = (HERE / "extract.js").read_text(encoding="utf-8")
ROUTE_PROBE_JS = (HERE / "route_probe.js").read_text(encoding="utf-8")


def load_config(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def apply_auth(page: Page, config: dict[str, Any]) -> None:
    auth = config.get("auth", {})
    if not auth.get("enabled"):
        return
    base = config["baseUrl"].rstrip("/")
    page.goto(base + auth.get("loginPath", "/"), timeout=config["navigationTimeoutMs"])
    for step in auth.get("steps", []):
        action = step["action"]
        selector = step.get("selector")
        try:
            if action == "fill":
                page.fill(selector, step.get("value", ""))
            elif action == "click":
                page.click(selector)
            elif action == "waitForSelector":
                page.wait_for_selector(selector, timeout=config["navigationTimeoutMs"])
            elif action == "goto":
                page.goto(base + step.get("value", "/"), timeout=config["navigationTimeoutMs"])
        except PWTimeout:
            print(f"[auth] step timed out: {step}")
    page.wait_for_timeout(config.get("settleMs", 500))


def extract_page(page: Page) -> dict[str, Any]:
    return page.evaluate(EXTRACT_JS)


def should_ignore(path: str, patterns: list[str]) -> bool:
    return any(re.search(p, path) for p in patterns)


def risk_for(text: str, rules: list[dict[str, str]]) -> str:
    lowered = (text or "").lower()
    for rule in rules:
        if re.search(rule["match"], lowered):
            return rule["risk"]
    return "low"


def build_action(route_norm: str, el: dict[str, Any], rules: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "id": fp.action_id(route_norm, el),
        "name": el.get("text") or el.get("name") or el.get("tag"),
        "event": fp.action_event(el.get("tag"), el.get("type")),
        "risk": risk_for(f"{el.get('text','')} {el.get('name','')}", rules),
        "selector": (
            f"[data-testid='{el['testid']}']" if el.get("testid")
            else f"#{el['id']}" if el.get("id")
            else el.get("cssPath")
        ),
    }


# ---------------------------------------------------------------------------
# Route discovery sources
# ---------------------------------------------------------------------------
# Each function returns a list of same-origin pathnames (leading slash). They
# are best-effort and never raise: a source that fails simply contributes
# nothing, keeping the crawler robust across very different apps.

def discover_from_config(config: dict[str, Any]) -> list[str]:
    """Seed paths explicitly listed in the config."""
    paths = [config.get("startPath", "/")]
    paths.extend(config.get("seedPaths", []))
    return paths


def discover_from_route_probe(page: Page, config: dict[str, Any]) -> list[str]:
    """Ask the running SPA to enumerate its own route table (route_probe.js)."""
    if not config.get("discovery", {}).get("routeProbe", True):
        return []
    try:
        return page.evaluate(ROUTE_PROBE_JS, config.get("discovery", {})) or []
    except Exception as exc:  # noqa: BLE001 - probe must never break the crawl
        print(f"[discover] route probe failed: {exc}")
        return []


def _fetch_text(url: str, timeout: float) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "coverage-crawler"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as exc:
        print(f"[discover] fetch failed for {url}: {exc}")
        return None


def discover_from_openapi(base: str, config: dict[str, Any]) -> list[str]:
    """Pull path templates from an OpenAPI/Swagger spec, if configured."""
    disc = config.get("discovery", {})
    spec_path = disc.get("openApiPath")
    if not spec_path:
        return []
    timeout = config.get("navigationTimeoutMs", 15000) / 1000
    raw = _fetch_text(base + spec_path, timeout)
    if not raw:
        return []
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError:
        return []
    # OpenAPI path templates use {param}; keep them so normalization collapses
    # them consistently with crawled dynamic segments.
    return [p for p in (spec.get("paths") or {}).keys() if isinstance(p, str) and p.startswith("/")]


def discover_from_sitemap(base: str, config: dict[str, Any]) -> list[str]:
    """Read same-origin URLs from a sitemap.xml, if configured."""
    disc = config.get("discovery", {})
    sitemap_path = disc.get("sitemapPath")
    if not sitemap_path:
        return []
    timeout = config.get("navigationTimeoutMs", 15000) / 1000
    raw = _fetch_text(base + sitemap_path, timeout)
    if not raw:
        return []
    paths: list[str] = []
    try:
        root = ET.fromstring(raw)
        for loc in root.iter():
            if loc.tag.endswith("loc") and loc.text:
                text = loc.text.strip()
                if text.startswith(base):
                    paths.append(text[len(base):] or "/")
    except ET.ParseError as exc:
        print(f"[discover] sitemap parse failed: {exc}")
    return paths


def gather_seed_paths(
    page: Page,
    base: str,
    config: dict[str, Any],
    dynamic: list[str],
    ignore: list[str],
) -> list[str]:
    """Merge every discovery source into a de-duplicated, filtered seed list."""
    candidates: list[str] = []
    candidates += discover_from_config(config)
    candidates += discover_from_route_probe(page, config)
    candidates += discover_from_openapi(base, config)
    candidates += discover_from_sitemap(base, config)

    seen: set[str] = set()
    ordered: list[str] = []
    for raw in candidates:
        if not raw:
            continue
        path = raw if raw.startswith("/") else "/" + raw
        norm = fp.normalize_path(path, dynamic)
        if should_ignore(norm, ignore):
            continue
        # De-dupe on the *raw* path so distinct concrete routes are all visited,
        # but skip if we've already queued this exact path.
        if path in seen:
            continue
        seen.add(path)
        ordered.append(path)
    return ordered


def crawl(config: dict[str, Any]) -> dict[str, Any]:
    base = config["baseUrl"].rstrip("/")
    dynamic = config.get("dynamicSegmentPatterns", [])
    ignore = config.get("ignorePathPatterns", [])
    risk_rules = config.get("riskRules", [])
    nav_selectors = config.get("spaNavSelectors", ["a[href^='/']"])

    routes: dict[str, dict[str, Any]] = {}
    visited_norm: set[str] = set()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=config.get("headless", True))
        page = browser.new_page()
        apply_auth(page, config)

        # Seed the queue from every discovery source (config, SPA route probe,
        # OpenAPI, sitemap). goto-based navigation is reliable for SPAs, so we
        # visit each discovered route directly; SPA-click discovery below then
        # catches any routes reachable only through in-app navigation.
        seed_paths = gather_seed_paths(page, base, config, dynamic, ignore)
        queue: list[dict[str, Any]] = [{"kind": "goto", "path": p} for p in seed_paths]
        if not queue:
            queue.append({"kind": "goto", "path": config.get("startPath", "/")})
        print(f"[crawl] seeded {len(queue)} route(s) from discovery: "
              + ", ".join(p["path"] for p in queue[:12])
              + (" …" if len(queue) > 12 else ""))

        # Clicks are only a discovery fallback for pushState buttons that expose
        # no static path; give them a short, dedicated timeout so a stubborn
        # button never stalls the whole crawl.
        click_timeout = config.get("clickTimeoutMs", 3000)
        pages_crawled = 0
        while queue and pages_crawled < config.get("maxPages", 40):
            job = queue.pop(0)
            try:
                if job["kind"] == "goto":
                    page.goto(base + job["path"], timeout=config["navigationTimeoutMs"])
                elif job["kind"] == "click":
                    page.click(job["selector"], timeout=click_timeout, no_wait_after=True)
                page.wait_for_timeout(config.get("settleMs", 500))
            except PWTimeout:
                # Non-fatal: a click fallback that cannot resolve is expected when
                # routes are already reachable via goto. Only surface goto misses.
                if job["kind"] == "goto":
                    print(f"[crawl] navigation timed out: {job}")
                continue
            except Exception as exc:  # noqa: BLE001 - stale/detached locators, etc.
                if job["kind"] == "goto":
                    print(f"[crawl] navigation failed: {job}: {exc}")
                continue

            snapshot = extract_page(page)
            norm = fp.normalize_path(snapshot["pathname"], dynamic)
            if should_ignore(norm, ignore):
                continue
            pages_crawled += 1

            if norm not in visited_norm:
                visited_norm.add(norm)
                record_route(routes, norm, snapshot, risk_rules, config)

            # Enqueue SPA navigation targets discovered on this page.
            enqueue_nav(page, queue, nav_selectors, base, dynamic, ignore, visited_norm)
            # Enqueue plain same-origin links.
            enqueue_links(snapshot["links"], queue, base, dynamic, ignore, visited_norm, config)

        browser.close()

    return assemble(routes, config)


def record_route(routes, norm, snapshot, risk_rules, config) -> None:
    rid = fp.route_id(norm)
    components: dict[str, dict[str, Any]] = {}
    max_actions = config.get("maxActionsPerPage", 400)
    for el in snapshot["elements"][:max_actions]:
        ckey = el.get("container") or "page"
        cid = fp.component_id(norm, ckey)
        comp = components.setdefault(
            cid,
            {"id": cid, "name": ckey, "selector": None, "actions": {}, "workflows": []},
        )
        action = build_action(norm, el, risk_rules)
        comp["actions"].setdefault(action["id"], action)

    routes[rid] = {
        "id": rid,
        "path": norm,
        "name": snapshot.get("title") or norm,
        "risk": risk_for(norm, risk_rules),
        "components": [
            {**c, "actions": list(c["actions"].values())} for c in components.values()
        ],
    }


def enqueue_nav(page, queue, selectors, base, dynamic, ignore, visited) -> None:
    """Discover in-app navigation targets.

    Prefer resolving a nav element to a concrete path (via href / data-nav) and
    enqueue a reliable ``goto`` job. Only fall back to clicking when the target
    path cannot be determined statically (e.g. pure pushState buttons). This
    keeps the queue stable even when clicking navigates the page away.
    """
    for selector in selectors:
        try:
            handles = page.locator(selector)
            count = handles.count()
        except Exception:
            continue
        for i in range(min(count, 50)):
            el = handles.nth(i)
            path = None
            try:
                path = el.get_attribute("href") or el.get_attribute("data-nav")
            except Exception:
                path = None
            if path and (path.startswith("/") or path.startswith(base)):
                rel = path[len(base):] if path.startswith(base) else path
                if not rel.startswith("/"):
                    continue
                norm = fp.normalize_path(rel, dynamic)
                if norm in visited or should_ignore(norm, ignore):
                    continue
                if not any(j.get("path") == rel for j in queue):
                    queue.append({"kind": "goto", "path": rel})
            else:
                unique = f"{selector} >> nth={i}"
                if not any(j.get("selector") == unique for j in queue):
                    queue.append({"kind": "click", "selector": unique})


def enqueue_links(links, queue, base, dynamic, ignore, visited, config) -> None:
    for href in links:
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        if href.startswith("http") and not href.startswith(base):
            if config.get("sameOriginOnly", True):
                continue
        path = href[len(base):] if href.startswith(base) else href
        if not path.startswith("/"):
            continue
        norm = fp.normalize_path(path, dynamic)
        if norm in visited or should_ignore(norm, ignore):
            continue
        if not any(j.get("path") == path for j in queue):
            queue.append({"kind": "goto", "path": path})


def assemble(routes, config) -> dict[str, Any]:
    route_list = list(routes.values())
    return {
        "application": {
            "id": config["applicationId"],
            "name": config.get("name", config["applicationId"]),
            "baseUrl": config["baseUrl"],
            "generatedBy": "06-inventory-crawler",
            "routes": route_list,
            # Workflows are business-level and cannot be inferred; keep an
            # empty, human-editable overlay so re-crawling never wipes them.
            "workflows": [],
        }
    }


def apply_overrides(config: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    """Layer CLI overrides on top of the base config.

    Lets callers (e.g. the dashboard/API) crawl an arbitrary base URL with
    optional login credentials without editing crawl.config.json.
    """
    if args.base_url:
        config["baseUrl"] = args.base_url
    if args.app_id:
        config["applicationId"] = args.app_id
    if args.name:
        config["name"] = args.name

    # Build a login sequence from simple credential flags if provided. This
    # covers the common email+password+submit pattern; complex flows can still
    # use auth.steps in the config file.
    if args.username or args.password:
        auth = config.setdefault("auth", {})
        auth["enabled"] = True
        auth.setdefault("loginPath", args.login_path or "/")
        if args.login_path:
            auth["loginPath"] = args.login_path
        steps: list[dict[str, Any]] = []
        if args.username:
            steps.append({"action": "fill", "selector": args.username_selector, "value": args.username})
        if args.password:
            steps.append({"action": "fill", "selector": args.password_selector, "value": args.password})
        steps.append({"action": "click", "selector": args.submit_selector})
        if args.ready_selector:
            steps.append({"action": "waitForSelector", "selector": args.ready_selector})
        auth["steps"] = steps
    elif args.no_auth:
        config.setdefault("auth", {})["enabled"] = False
    return config


def main() -> None:
    parser = argparse.ArgumentParser(description="Dynamic inventory crawler")
    parser.add_argument("--config", default=str(HERE / "crawl.config.json"))
    parser.add_argument("--out", default=str(HERE.parent / "01-module-inventory" / "module_inventory.json"))
    # Dynamic per-app overrides (used by the dashboard "onboard any URL" flow).
    parser.add_argument("--base-url", help="Override baseUrl to crawl any application")
    parser.add_argument("--app-id", help="Override applicationId (used for the inventory filename)")
    parser.add_argument("--name", help="Human-friendly application name")
    parser.add_argument("--no-auth", action="store_true", help="Disable the login flow")
    parser.add_argument("--username")
    parser.add_argument("--password")
    parser.add_argument("--login-path", help="Path to the login page (default '/')")
    parser.add_argument("--username-selector", default="input[name='email']")
    parser.add_argument("--password-selector", default="input[name='password']")
    parser.add_argument("--submit-selector", default="button[type='submit']")
    parser.add_argument("--ready-selector", help="Selector that signals a successful login")
    args = parser.parse_args()

    config = apply_overrides(load_config(Path(args.config)), args)
    inventory = crawl(config)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(inventory, indent=2), encoding="utf-8")

    routes = inventory["application"]["routes"]
    actions = sum(len(c["actions"]) for r in routes for c in r["components"])
    print(f"Discovered {len(routes)} routes, "
          f"{sum(len(r['components']) for r in routes)} components, "
          f"{actions} actions -> {out_path}")


if __name__ == "__main__":
    main()
