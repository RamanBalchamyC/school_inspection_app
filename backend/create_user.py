"""Create a user: python create_user.py --email a@b.com --name "Name" --role admin
The password is prompted for (not passed on the command line)."""
import argparse
import getpass

import bcrypt
from sqlalchemy import select
from sqlalchemy.orm import Session

from main import User, engine

parser = argparse.ArgumentParser()
parser.add_argument("--email", required=True)
parser.add_argument("--name", required=True)
parser.add_argument("--role", choices=["officer", "admin"], default="officer")
args = parser.parse_args()

password = getpass.getpass("Password (exactly 8 chars): ")
if len(password) != 8 or password != getpass.getpass("Repeat password: "):
    raise SystemExit("Passwords must match and be exactly 8 characters.")

with Session(engine) as db:
    email = args.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    hashed = bcrypt.hashpw(password.encode()[:72], bcrypt.gensalt()).decode()
    if user:
        user.password_hash, user.original_password, user.name, user.role = hashed, password, args.name, args.role
        print("Updated existing user.")
    else:
        db.add(User(email=email, name=args.name, role=args.role, password_hash=hashed, original_password=password))
        print("Created user.")
    db.commit()
