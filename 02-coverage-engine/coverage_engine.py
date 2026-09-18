"""JSON-backed coverage comparison engine for the pilot."""
from __future__ import annotations

from collections import Counter
from typing import Any

LEVELS = ("routes", "components", "actions", "workflows")


def _inventory_nodes(inventory: dict[str, Any]) -> dict[str, dict[str, Any]]:
    app = inventory["application"]
    nodes = {level: {} for level in LEVELS}
    for route in app.get("routes", []):
        nodes["routes"][route["id"]] = route
        for component in route.get("components", []):
            nodes["components"][component["id"]] = component
            for action in component.get("actions", []):
                nodes["actions"][action["id"]] = action
    for workflow in app.get("workflows", []):
        nodes["workflows"][workflow["id"]] = workflow
    return nodes


def compare(inventory: dict[str, Any], events: list[dict[str, Any]], session: dict[str, Any] | None = None) -> dict[str, Any]:
    expected = _inventory_nodes(inventory)
    observed = {level: set() for level in LEVELS}
    for event in events:
        for level in LEVELS:
            value = event.get(f"{level[:-1]}Id") if level != "routes" else event.get("routeId")
            if value:
                observed[level].add(value)
        for workflow_id in event.get("workflowIds", []):
            observed["workflows"].add(workflow_id)

    levels: dict[str, Any] = {}
    for level in LEVELS:
        expected_ids = set(expected[level])
        covered = sorted(expected_ids & observed[level])
        missed = sorted(expected_ids - observed[level])
        levels[level] = {
            "expected": len(expected_ids),
            "covered": len(covered),
            "missed": len(missed),
            "coverage": round(len(covered) * 100 / len(expected_ids), 1) if expected_ids else 100,
            "gaps": [
                {"id": node_id, "name": expected[level][node_id].get("name"), "risk": expected[level][node_id].get("risk", "medium"), "impact": expected[level][node_id].get("impact", "Coverage not observed")}
                for node_id in missed
            ],
        }

    action_observed = observed["actions"]
    partial = []
    for workflow in expected["workflows"].values():
        required = set(workflow.get("requiredActions", []))
        matched = required & action_observed
        if matched and matched != required:
            partial.append({"id": workflow["id"], "name": workflow["name"], "coveredActions": len(matched), "expectedActions": len(required)})
    total_expected = sum(level["expected"] for level in levels.values())
    total_covered = sum(level["covered"] for level in levels.values())
    return {
        "session": session or {},
        "overall": {"expected": total_expected, "covered": total_covered, "missed": total_expected - total_covered, "coverage": round(total_covered * 100 / total_expected, 1) if total_expected else 100},
        "levels": levels,
        "partialWorkflows": partial,
        "eventCount": len(events),
        "eventSources": dict(Counter(event.get("source", "unknown") for event in events)),
        "recommendations": [f"Prioritize {gap['name']} ({gap['risk']} risk)" for gap in levels["actions"]["gaps"][:5]],
    }


if __name__ == "__main__":
    import json, sys
    inventory = json.load(open(sys.argv[1], encoding="utf-8"))
    events = json.load(open(sys.argv[2], encoding="utf-8"))
    print(json.dumps(compare(inventory, events), indent=2))
