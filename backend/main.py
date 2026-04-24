from dotenv import load_dotenv
load_dotenv(override=True)

import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    from backend.database import init_db
    await init_db()
    yield

app = FastAPI(title="vibe-writer", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from backend.routers.jobs import router as jobs_router
from backend.routers.articles import router as articles_router
app.include_router(jobs_router)
app.include_router(articles_router)

@app.get("/health")
async def health():
    return {"status": "ok"}
