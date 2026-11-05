from __future__ import annotations

import json
import uuid

from ..db import now_iso

DEFAULT_LAYERS = {
    "wardrobe": 3,
    "drawer_unit": 3,
    "storage_box": 1,
    "shelf": 4,
    "bed": 1,
    "coffee_table": 1,
    "desk": 1,
    "custom_box": 1,
}

KIND_BY_PRESET = {
    "wardrobe": "shelf",
    "drawer_unit": "drawer",
    "storage_box": "box",
    "shelf": "shelf",
    "bed": "box",
    "coffee_table": "shelf",
    "desk": "drawer",
    "custom_box": "box",
}

PRESET_NAMES = {
    "wardrobe": "衣柜",
    "drawer_unit": "抽屉柜",
    "storage_box": "收纳箱",
    "shelf": "置物架",
    "bed": "床下",
    "coffee_table": "茶几",
    "desk": "书桌",
    "custom_box": "自定义收纳",
}


class CompartmentNotEmpty(Exception):
    def __init__(self, names: list[str]) -> None:
        self.names = names


def parse_config(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        return {}


def default_layers(preset: str) -> int:
    return int(DEFAULT_LAYERS.get(preset, 1))


def normalize_config(preset: str, config: dict | None) -> dict:
    config = dict(config or {})
    layers = config.get("layers", default_layers(preset))
    try:
        layers = int(layers)
    except (TypeError, ValueError):
        layers = default_layers(preset)
    layers = max(1, min(8, layers))
    cols = config.get("cols", 1)
    try:
        cols = int(cols)
    except (TypeError, ValueError):
        cols = 1
    cols = max(1, min(3, cols))
    doors = config.get("doors", 2 if preset == "wardrobe" else 0)
    try:
        doors = int(doors)
    except (TypeError, ValueError):
        doors = 0
    return {**config, "layers": layers, "cols": cols, "doors": max(0, min(4, doors))}


def compartment_name(preset: str, level: int, col: int, layers: int, cols: int) -> str:
    if preset == "bed":
        base = "床下"
    elif preset == "coffee_table":
        base = "下层"
    elif preset in {"storage_box", "custom_box"}:
        base = "箱内"
    elif preset == "desk":
        base = "抽屉"
    elif preset == "wardrobe" and layers == 3:
        base = ["顶层", "中层", "下层"][level]
    else:
        base = f"第 {level + 1} 层"
    if cols <= 1:
        return base
    suffix = ["左", "中", "右"][col] if cols == 3 else str(col + 1)
    return f"{base} · {suffix}"


def desired_compartments(preset: str, config: dict) -> list[dict]:
    layers = config["layers"]
    cols = config["cols"]
    kind = KIND_BY_PRESET.get(preset, "box")
    result = []
    for level in range(layers):
        for col in range(cols):
            result.append(
                {
                    "name": compartment_name(preset, level, col, layers, cols),
                    "kind": kind,
                    "level_index": level,
                    "row": 0,
                    "col": col,
                }
            )
    return result


def sync_compartments(connection, container_id: str, preset: str, config: dict) -> list:
    existing = connection.execute(
        "SELECT * FROM compartments WHERE container_id = ? ORDER BY level_index, col, sort",
        (container_id,),
    ).fetchall()
    existing_by_key = {(row["level_index"], row["row"], row["col"]): row for row in existing}
    desired = desired_compartments(preset, config)
    desired_keys = set()
    sort = 0

    for item in desired:
        key = (item["level_index"], item["row"], item["col"])
        desired_keys.add(key)
        current = existing_by_key.get(key)
        if current:
            connection.execute(
                "UPDATE compartments SET default_name = ?, name = COALESCE(custom_name, ?), kind = ?, sort = ? WHERE id = ?",
                (item["name"], item["name"], item["kind"], sort, current["id"]),
            )
        else:
            connection.execute(
                """
                INSERT INTO compartments
                    (id, container_id, parent_id, name, default_name, kind, level_index, row, col, sort)
                VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    container_id,
                    item["name"],
                    item["name"],
                    item["kind"],
                    item["level_index"],
                    item["row"],
                    item["col"],
                    sort,
                ),
            )
        sort += 1

    removed_names: list[str] = []
    for key, row in existing_by_key.items():
        if key in desired_keys:
            continue
        count = connection.execute(
            "SELECT COUNT(*) AS n FROM items WHERE compartment_id = ?", (row["id"],)
        ).fetchone()["n"]
        if count:
            removed_names.append(row["name"])
        else:
            connection.execute("DELETE FROM compartments WHERE id = ?", (row["id"],))
    if removed_names:
        raise CompartmentNotEmpty(removed_names)

    return connection.execute(
        "SELECT * FROM compartments WHERE container_id = ? ORDER BY level_index, col, sort",
        (container_id,),
    ).fetchall()


def serialize_compartment(row) -> dict:
    return {
        "id": row["id"],
        "container_id": row["container_id"],
        "name": row["name"],
        "custom_name": row["custom_name"],
        "default_name": row["default_name"],
        "kind": row["kind"],
        "level_index": row["level_index"],
        "row": row["row"],
        "col": row["col"],
        "sort": row["sort"],
    }


def serialize_room(row) -> dict:
    return {
        "id": row["id"],
        "version": row["version"],
        "floor_id": row["floor_id"],
        "name": row["name"],
        "width_cm": row["width_cm"],
        "depth_cm": row["depth_cm"],
        "height_cm": row["height_cm"],
        "wall_color": row["wall_color"],
        "sort": row["sort"],
        "container_count": row["container_count"] if "container_count" in row.keys() else 0,
    }


def serialize_container(row, compartments: list) -> dict:
    return {
        "id": row["id"],
        "room_id": row["room_id"],
        "preset": row["preset"],
        "name": row["name"],
        "x_cm": row["x_cm"],
        "z_cm": row["z_cm"],
        "y_cm": row["y_cm"],
        "rot_deg": row["rot_deg"],
        "width_cm": row["width_cm"],
        "depth_cm": row["depth_cm"],
        "height_cm": row["height_cm"],
        "color": row["color"],
        "config": parse_config(row["config_json"]),
        "compartments": [serialize_compartment(item) for item in compartments],
        "item_count": row["item_count"] if "item_count" in row.keys() else 0,
        "version": row["version"],
    }


def ensure_default_floor(connection, household_id: str):
    floor = connection.execute(
        "SELECT * FROM floors WHERE household_id = ? ORDER BY level, sort LIMIT 1",
        (household_id,),
    ).fetchone()
    if floor:
        return floor
    floor_id = str(uuid.uuid4())
    connection.execute(
        "INSERT INTO floors (id, household_id, name, level, sort) VALUES (?, ?, ?, 1, 0)",
        (floor_id, household_id, "1 层"),
    )
    return connection.execute("SELECT * FROM floors WHERE id = ?", (floor_id,)).fetchone()
