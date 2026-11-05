from __future__ import annotations

from .history import ITEM_QUERY


def _filters(household_id: str, *, status: str | None, q: str, compartment_id: str | None,
             room_id: str | None, location_status: str | None, ids: list[str] | None):
    clauses = ["i.household_id = :household_id"]
    parameters = {"household_id": household_id}
    if status is not None:
        clauses.append("i.archived_at IS NULL" if status == "active" else "i.archived_at IS NOT NULL")
    if compartment_id:
        clauses.append("i.compartment_id = :compartment_id")
        parameters["compartment_id"] = compartment_id
    if room_id:
        clauses.append("r.id = :room_id")
        parameters["room_id"] = room_id
    if location_status:
        clauses.append("i.location_status = :location_status")
        parameters["location_status"] = location_status
    if ids is not None:
        if not ids:
            clauses.append("0")
        else:
            keys = [f"item_id_{index}" for index in range(len(ids))]
            clauses.append("i.id IN (" + ",".join(":" + key for key in keys) + ")")
            parameters.update(zip(keys, ids))
    query = q.strip().casefold()
    if query:
        parameters["query"] = query
        clauses.append("""(
            instr(casefold(i.name), :query) > 0
            OR EXISTS (SELECT 1 FROM json_each(i.aliases_json) alias WHERE instr(casefold(alias.value), :query) > 0)
            OR instr(casefold(i.notes), :query) > 0
        )""")
    return " WHERE " + " AND ".join(clauses), parameters, bool(query)


def _ordering(searching: bool):
    rank = """CASE
        WHEN casefold(i.name) = :query THEN 0
        WHEN instr(casefold(i.name), :query) = 1 THEN 1
        WHEN instr(casefold(i.name), :query) > 0 THEN 2
        WHEN EXISTS (SELECT 1 FROM json_each(i.aliases_json) alias WHERE instr(casefold(alias.value), :query) > 0) THEN 3
        ELSE 4 END, """ if searching else ""
    return " ORDER BY " + rank + "i.updated_at DESC, i.name, i.id"


def iter_items(connection, household_id: str, *, status: str | None = "active", q: str = "",
               compartment_id: str | None = None, room_id: str | None = None,
               location_status: str | None = None, ids: list[str] | None = None,
               limit: int | None = None, offset: int = 0):
    """SQLite filters and ranks literal Unicode matches before materializing rows."""
    where, parameters, searching = _filters(household_id, status=status, q=q, compartment_id=compartment_id,
                                           room_id=room_id, location_status=location_status, ids=ids)
    sql = ITEM_QUERY + where + _ordering(searching)
    if limit is not None:
        sql += " LIMIT :limit OFFSET :offset"
        parameters.update(limit=limit, offset=offset)
    return connection.execute(sql, parameters)


def count_items(connection, household_id: str, *, status: str | None = "active", q: str = "",
                compartment_id: str | None = None, room_id: str | None = None,
                location_status: str | None = None, ids: list[str] | None = None) -> int:
    where, parameters, _ = _filters(household_id, status=status, q=q, compartment_id=compartment_id,
                                    room_id=room_id, location_status=location_status, ids=ids)
    return connection.execute("SELECT COUNT(*) FROM (" + ITEM_QUERY + where + ")", parameters).fetchone()[0]


def room_belongs_to_household(connection, room_id: str, household_id: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM rooms r JOIN floors f ON f.id=r.floor_id WHERE r.id=? AND f.household_id=?",
        (room_id, household_id),
    ).fetchone() is not None
