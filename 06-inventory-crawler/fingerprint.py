"""Deterministic fingerprinting for routes, components, and actions.

The crawler and the browser extension MUST derive identical IDs so that
observed automation events line up with the discovered inventory. Keep the
rules in this module in sync with `shared/fingerprint.js` (used by the
extension). Any change to normalization here must be mirrored there.
"""
from __future__ import annotations

import hashlib
import re
from typing import Iterable

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slug(text: str) -> str:
    """Lowercase, hyphenated, trimmed slug."""
    text = (text or "").strip().lower()
    text = _SLUG_RE.sub("-", text)
    return text.strip("-")


def short_hash(value: str, length: int = 8) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:length]


def normalize_path(pathname: str, dynamic_patterns: Iterable[str]) -> str:
    """Collapse dynamic URL segments so /orders/123 == /orders/{id}."""
    compiled = [re.compile(p) for p in dynamic_patterns]
    pathname = (pathname or "/").split("?")[0].split("#")[0]
    if not pathname.startswith("/"):
        pathname = "/" + pathname
    pathname = re.sub(r"/+", "/", pathname).rstrip("/") or "/"
    parts = pathname.split("/")
    out = []
    for part in parts:
        if not part:
            out.append(part)
            continue
        if any(rx.search(part) for rx in compiled):
            out.append("{id}")
        else:
            out.append(part)
    return "/".join(out) or "/"


def route_id(normalized_path: str) -> str:
    if normalized_path in ("", "/"):
        return "route-root"
    body = slug(normalized_path.replace("{id}", "id"))
    return f"route-{body or 'root'}"


def element_key(el: dict) -> str:
    """Stable identity for an element using a fallback chain.

    el is a dict of attributes captured in the browser:
    testid, coverageId, id, name, ariaLabel, role, tag, text, cssPath.
    """
    for attr in ("testid", "coverageId"):
        if el.get(attr):
            return f"{attr}:{el[attr]}"
    if el.get("id"):
        return f"id:{el['id']}"
    if el.get("name"):
        return f"name:{el['name']}"
    if el.get("ariaLabel"):
        return f"aria:{slug(el['ariaLabel'])}"
    role = el.get("role") or el.get("tag") or "el"
    text = slug(el.get("text", ""))[:40]
    if text:
        return f"{role}:{text}"
    # Last resort: hash the CSS path so it is at least stable per render.
    return f"path:{short_hash(el.get('cssPath', ''))}"


def component_id(route_norm_path: str, container_key: str) -> str:
    return f"component-{route_id(route_norm_path)[6:]}-{slug(container_key) or short_hash(container_key)}"


def action_id(route_norm_path: str, el: dict) -> str:
    return f"action-{route_id(route_norm_path)[6:]}-{slug(element_key(el))}"


def action_event(tag: str, el_type: str | None) -> str:
    tag = (tag or "").lower()
    el_type = (el_type or "").lower()
    if tag == "form":
        return "submit"
    if tag in ("select", "textarea"):
        return "change"
    if tag == "input":
        if el_type in ("submit", "button", "checkbox", "radio"):
            return "click"
        return "change"
    return "click"
