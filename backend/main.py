from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="vibe-writer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from backend.routers.jobs import router as jobs_router
app.include_router(jobs_router)

@app.get("/health")
async def health():
    return {"status": "ok"}
