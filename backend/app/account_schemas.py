from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
Username = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_\-\u4e00-\u9fa5]+$")]


class ProfileUpdate(BaseModel):
    display_name: DisplayName


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class JoinHousehold(BaseModel):
    code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    username: Username
    display_name: DisplayName
    password: str = Field(min_length=8, max_length=200)
    remember: bool = False
    device_name: str | None = Field(default=None, max_length=60)
