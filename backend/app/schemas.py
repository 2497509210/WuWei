from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, field_validator

USERNAME_PATTERN = r"^[A-Za-z0-9_\-\u4e00-\u9fa5]+$"


class SetupIn(BaseModel):
    token: str = Field(min_length=1, max_length=200)
    household_name: str = Field(min_length=1, max_length=60)
    username: str = Field(min_length=1, max_length=40, pattern=USERNAME_PATTERN)
    password: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)
    remember: bool = False
    device_name: str | None = Field(default=None, max_length=60)


class FloorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    level: int = Field(ge=-5, le=50)


RoomName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class RoomCreate(BaseModel):
    name: RoomName
    floor_id: str | None = None
    width_cm: int = Field(ge=100, le=2000)
    depth_cm: int = Field(ge=100, le=2000)
    height_cm: int = Field(ge=200, le=400)
    wall_color: str | None = Field(default=None, max_length=20)


class RoomUpdate(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    name: RoomName | None = None
    width_cm: int | None = Field(default=None, ge=100, le=2000)
    depth_cm: int | None = Field(default=None, ge=100, le=2000)
    height_cm: int | None = Field(default=None, ge=200, le=400)
    wall_color: str | None = Field(default=None, max_length=20)


PRESETS = (
    "wardrobe",
    "drawer_unit",
    "storage_box",
    "shelf",
    "bed",
    "coffee_table",
    "desk",
    "custom_box",
)


class ContainerCreate(BaseModel):
    room_id: str
    preset: str
    name: str = Field(min_length=1, max_length=40)
    x_cm: int = Field(ge=0, le=2000)
    z_cm: int = Field(ge=0, le=2000)
    y_cm: int = Field(default=0, ge=0, le=300)
    rot_deg: Literal[0, 90, 180, 270] = 0
    width_cm: int = Field(ge=20, le=400)
    depth_cm: int = Field(ge=20, le=400)
    height_cm: int = Field(ge=10, le=300)
    color: str | None = Field(default=None, max_length=20)
    config: dict = Field(default_factory=dict)


class ContainerUpdate(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    room_id: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=40)
    x_cm: int | None = Field(default=None, ge=0, le=2000)
    z_cm: int | None = Field(default=None, ge=0, le=2000)
    y_cm: int | None = Field(default=None, ge=0, le=300)
    rot_deg: Literal[0, 90, 180, 270] | None = None
    width_cm: int | None = Field(default=None, ge=20, le=400)
    depth_cm: int | None = Field(default=None, ge=20, le=400)
    height_cm: int | None = Field(default=None, ge=10, le=300)
    color: str | None = Field(default=None, max_length=20)
    config: dict | None = None


ItemName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class ItemBatchIn(BaseModel):
    compartment_id: str = Field(min_length=1)
    names: list[ItemName] = Field(min_length=1, max_length=100)
    operation_id: str = Field(min_length=1, max_length=100)


class ItemVersionIn(BaseModel):
    expected_version: int = Field(ge=1)


class ItemArchiveIn(ItemVersionIn):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class ItemRestoreIn(ItemVersionIn):
    compartment_id: str = Field(min_length=1)


class CompartmentUpdate(BaseModel):
    expected_container_version: int = Field(ge=1)
    custom_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] | None


class ItemUpdate(ItemVersionIn):
    name: ItemName | None = None
    aliases: list[ItemName] | None = Field(default=None, max_length=20)
    notes: str | None = Field(default=None, max_length=4000)
    quantity: int | None = Field(default=None, ge=1, le=100000)
    compartment_id: str | None = Field(default=None, min_length=1)

    @field_validator("name", "aliases", "quantity", "compartment_id")
    @classmethod
    def supplied_values_cannot_be_null(cls, value):
        if value is None:
            raise ValueError("该字段不能为 null")
        return value
