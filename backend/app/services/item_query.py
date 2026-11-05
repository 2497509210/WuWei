from __future__ import annotations

import json

from .history import ITEM_QUERY


def iter_items(connection, household_id: str, *, status: str | None = "active", q: str = "",
               compartment_id: str | None = None, ids: list[str] | None = None):
    """Shared literal Unicode search for both the displayed list and exports."""
    clauses, parameters = ["i.household_id = ?"], [household_id]
    if status is not None:
        clauses.append("i.archived_at IS NULL" if status == "active" else "i.archived_at IS NOT NULL")
    if compartment_id:
        clauses.append("i.compartment_id = ?")
        parameters.append(compartment_id)
    if ids is not None:
        if not ids:
            return
        clauses.append("i.id IN (" + ",".join("?" for _ in ids) + ")")
        parameters.extend(ids)
    query = q.strip().casefold()
    rows = connection.execute(ITEM_QUERY + " WHERE " + " AND ".join(clauses)
                              + " ORDER BY i.updated_at DESC, i.name, i.id", parameters)
    for row in rows:
        if not query or any(query in text.casefold() for text in [row["name"], row["notes"] or "", *json.loads(row["aliases_json"])]):
            yield row
