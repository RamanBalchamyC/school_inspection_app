from __future__ import annotations

import csv
import io
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus
from uuid import uuid4

import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    create_engine,
    func,
    inspect,
    or_,
    select,
    text,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

JWT_SECRET = os.getenv("JWT_SECRET", "")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "720"))
if len(JWT_SECRET) < 16 or JWT_SECRET.startswith("change-me"):
    raise RuntimeError("Set a long random JWT_SECRET in backend/.env")

DATABASE_URL = (
    f"mysql+pymysql://{quote_plus(os.getenv('MYSQL_USER', 'root'))}:"
    f"{quote_plus(os.getenv('MYSQL_PASSWORD', ''))}@{os.getenv('MYSQL_HOST', 'localhost')}:"
    f"{os.getenv('MYSQL_PORT', '3306')}/{os.getenv('MYSQL_DATABASE', 'school_inspection')}"
    "?charset=utf8mb4"
)
engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_recycle=1800)


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(190), unique=True)
    name: Mapped[str] = mapped_column(String(150))
    password_hash: Mapped[str] = mapped_column(String(100))
    # Plain-text copy of the password, stored at the product owner's request.
    original_password: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="officer")  # officer | admin
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Inspection(Base):
    __tablename__ = "inspections"
    __table_args__ = (
        Index("idx_inspections_district", "district"),
        Index("idx_inspections_date", "inspection_date", "created_at"),
        Index("idx_inspections_user", "user_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(36), unique=True)  # idempotency key
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    district: Mapped[str] = mapped_column(String(100))
    block: Mapped[str] = mapped_column(String(100))
    school_name: Mapped[str] = mapped_column(String(200))
    udise_code: Mapped[str] = mapped_column(String(11))
    school_type: Mapped[str] = mapped_column(String(100))
    inspection_date: Mapped[date] = mapped_column(Date)
    officer_name: Mapped[str] = mapped_column(String(150))
    priority: Mapped[str] = mapped_column(String(10))
    remarks: Mapped[str] = mapped_column(Text, default="")
    details: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    photos: Mapped[list["Photo"]] = relationship(
        back_populates="inspection", cascade="all, delete-orphan", order_by="Photo.id"
    )


class Photo(Base):
    __tablename__ = "inspection_photos"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    inspection_id: Mapped[str] = mapped_column(ForeignKey("inspections.id", ondelete="CASCADE"))
    filename: Mapped[str] = mapped_column(String(80), unique=True)
    inspection: Mapped[Inspection] = relationship(back_populates="photos")


Base.metadata.create_all(engine)
# create_all does not alter existing tables, so add the new column when upgrading.
if "original_password" not in {c["name"] for c in inspect(engine).get_columns("users")}:
    with engine.begin() as _conn:
        _conn.execute(text("ALTER TABLE users ADD COLUMN original_password VARCHAR(255) NULL"))

app = FastAPI(title="Tamil Nadu School Inspection API", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db():
    with Session(engine) as session:
        yield session


# ---------- auth ----------
def make_token(user: User) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    return jwt.encode({"sub": str(user.id), "exp": exp}, JWT_SECRET, algorithm="HS256")


def user_dict(user: User) -> dict[str, Any]:
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role}


def current_user(
    authorization: str | None = Header(default=None), db: Session = Depends(get_db)
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Not authenticated")
    try:
        data = jwt.decode(authorization[7:], JWT_SECRET, algorithms=["HS256"])
        user = db.get(User, int(data["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(401, "Session expired. Please sign in again.")
    if user is None:
        raise HTTPException(401, "Account not found")
    return user


class LoginBody(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
def login(body: LoginBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if user is None or not bcrypt.checkpw(body.password.encode()[:72], user.password_hash.encode()):
        raise HTTPException(401, "Incorrect email or password")
    return {"token": make_token(user), "user": user_dict(user)}


class SignupBody(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=150)
    email: str = Field(max_length=190)
    password: str = Field(min_length=8, max_length=8)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Enter a valid email address")
        return value


@app.post("/api/auth/signup", status_code=201)
def signup(body: SignupBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    if db.scalar(select(User).where(User.email == body.email)) is not None:
        raise HTTPException(409, "An account with this email already exists")
    user = User(
        email=body.email,
        name=body.name,
        password_hash=bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode(),
        original_password=body.password,
        role="officer",
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with this email already exists")
    return {"user": user_dict(user)}


@app.get("/api/auth/me")
def me(user: User = Depends(current_user)) -> dict[str, Any]:
    return user_dict(user)


# ---------- schemas ----------
class InspectionCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    client_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    district: str = Field(min_length=1, max_length=100)
    block: str = Field(min_length=1, max_length=100)
    school_name: str = Field(min_length=1, max_length=200)
    udise_code: str
    school_type: str = Field(min_length=1, max_length=100)
    inspection_date: date
    officer_name: str = Field(min_length=1, max_length=150)
    priority: str
    remarks: str = Field(default="", max_length=5000)
    details: dict[str, dict[str, str]]

    @field_validator("udise_code")
    @classmethod
    def validate_udise(cls, value: str) -> str:
        if not re.fullmatch(r"\d{11}", value):
            raise ValueError("UDISE code must contain exactly 11 digits")
        return value

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, value: str) -> str:
        if value not in {"High", "Medium", "Low"}:
            raise ValueError("Priority must be High, Medium, or Low")
        return value

    @field_validator("inspection_date")
    @classmethod
    def validate_date(cls, value: date) -> date:
        if value > date.today() + timedelta(days=1):
            raise ValueError("Inspection date cannot be in the future")
        return value

    @field_validator("details")
    @classmethod
    def validate_details(cls, value: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
        if len(value) > 10 or any(len(v) > 60 for v in value.values()):
            raise ValueError("Too many detail fields")
        for section in value.values():
            for k, v in section.items():
                if len(k) > 100 or len(v) > 3000:
                    raise ValueError("Detail value too long")
        return value


def record(row: Inspection) -> dict[str, Any]:
    return {
        "id": row.id,
        "district": row.district,
        "block": row.block,
        "school_name": row.school_name,
        "udise_code": row.udise_code,
        "school_type": row.school_type,
        "inspection_date": row.inspection_date.isoformat(),
        "officer_name": row.officer_name,
        "priority": row.priority,
        "remarks": row.remarks,
        "details": row.details,
        "photos": [f"/api/photos/{p.filename}" for p in row.photos],
        "created_at": row.created_at.isoformat() + "Z",
    }


def visible(user: User):
    return [] if user.role == "admin" else [Inspection.user_id == user.id]


def apply_filters(stmt, user: User, district: str | None, search: str | None):
    for cond in visible(user):
        stmt = stmt.where(cond)
    if district:
        stmt = stmt.where(Inspection.district == district)
    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                Inspection.school_name.like(term),
                Inspection.udise_code.like(term),
                Inspection.block.like(term),
                Inspection.district.like(term),
            )
        )
    return stmt


# ---------- routes ----------
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/inspections")
def list_inspections(
    district: str | None = None,
    search: str | None = None,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    base = apply_filters(select(Inspection), user, district, search)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.scalars(
        base.order_by(Inspection.inspection_date.desc(), Inspection.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return {"items": [record(r) for r in rows], "total": total}


@app.get("/api/inspections/export")
def export_csv(user: User = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    rows = db.scalars(
        apply_filters(select(Inspection), user, None, None).order_by(
            Inspection.inspection_date.desc()
        )
    ).all()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["District", "Block", "School", "UDISE", "Date", "Officer", "Priority", "Remarks"])
    for r in rows:
        # Prefix formula-like cells so spreadsheets don't execute them.
        cells = [r.district, r.block, r.school_name, r.udise_code, r.inspection_date.isoformat(),
                 r.officer_name, r.priority, r.remarks]
        writer.writerow([("'" + c) if c[:1] in "=+-@\t\r" and c else c for c in cells])
    return Response(
        "﻿" + out.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="school-inspections.csv"'},
    )


@app.get("/api/inspections/{inspection_id}")
def get_inspection(
    inspection_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict[str, Any]:
    row = db.get(Inspection, inspection_id)
    if row is None or (user.role != "admin" and row.user_id != user.id):
        raise HTTPException(404, "Inspection not found")
    return record(row)


@app.post("/api/inspections", status_code=201)
def create_inspection(
    payload: InspectionCreate, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict[str, Any]:
    existing = db.scalar(select(Inspection).where(Inspection.client_id == payload.client_id))
    if existing is not None:
        if existing.user_id != user.id:
            raise HTTPException(409, "Duplicate submission id")
        return record(existing)  # idempotent retry
    row = Inspection(
        id=str(uuid4()),
        user_id=user.id,
        **payload.model_dump(),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(Inspection).where(Inspection.client_id == payload.client_id))
        if existing is None or existing.user_id != user.id:
            raise HTTPException(409, "Duplicate submission id")
        return record(existing)
    db.refresh(row)
    return record(row)


MAGIC = [
    (b"\xff\xd8\xff", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
]


def sniff_image(content: bytes) -> str | None:
    for sig, ext in MAGIC:
        if content.startswith(sig):
            return ext
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    return None


@app.post("/api/inspections/{inspection_id}/photos")
async def upload_photos(
    inspection_id: str,
    files: list[UploadFile] = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, list[str]]:
    row = db.get(Inspection, inspection_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Inspection not found")
    if len(files) > 10 or len(row.photos) + len(files) > 20:
        raise HTTPException(400, "Too many photos")

    # Validate everything first so a bad file never leaves a partial upload.
    staged: list[tuple[str, bytes]] = []
    for upload in files:
        content = await upload.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024:
            raise HTTPException(413, "Each photo must be 10 MB or smaller")
        ext = sniff_image(content)
        if ext is None:
            raise HTTPException(400, "Only JPEG, PNG or WebP images are allowed")
        staged.append((f"{uuid4().hex}{ext}", content))

    written: list[Path] = []
    try:
        for name, content in staged:
            path = UPLOAD_DIR / name
            path.write_bytes(content)
            written.append(path)
            row.photos.append(Photo(filename=name))
        db.commit()
    except Exception:
        db.rollback()
        for path in written:
            path.unlink(missing_ok=True)
        raise HTTPException(500, "Could not save photos")
    return {"photos": [f"/api/photos/{p.filename}" for p in row.photos]}


@app.get("/api/photos/{filename}")
def get_photo(
    filename: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    if not re.fullmatch(r"[0-9a-f]{32}\.(jpg|png|webp)", filename):
        raise HTTPException(404, "Photo not found")
    photo = db.scalar(select(Photo).where(Photo.filename == filename))
    if photo is None or (user.role != "admin" and photo.inspection.user_id != user.id):
        raise HTTPException(404, "Photo not found")
    return FileResponse(UPLOAD_DIR / filename, headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/dashboard")
def dashboard(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    scope = visible(user)
    total = db.scalar(select(func.count()).select_from(Inspection).where(*scope)) or 0
    high = db.scalar(
        select(func.count()).select_from(Inspection).where(Inspection.priority == "High", *scope)
    ) or 0
    districts = db.execute(
        select(Inspection.district, func.count().label("c"))
        .where(*scope)
        .group_by(Inspection.district)
        .order_by(func.count().desc(), Inspection.district)
    ).all()
    return {
        "total_inspections": total,
        "high_priority": high,
        "districts_covered": len(districts),
        "districts": [{"name": d, "count": c} for d, c in districts],
    }
