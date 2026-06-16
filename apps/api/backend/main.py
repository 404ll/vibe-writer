from dotenv import load_dotenv
load_dotenv(override=True)

import logging
#设置日志格式
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

# 创建 FastAPI 应用实例，并指定生命周期函数
app = FastAPI(title="vibe-writer", lifespan=lifespan)

# 配置 CORS 中间件，允许来自指定来源的请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 导入并注册路由
from backend.routers.jobs import router as jobs_router
from backend.routers.articles import router as articles_router
app.include_router(jobs_router)
app.include_router(articles_router)

# 提供一个简单的健康检查端点，返回服务状态
@app.get("/health")
async def health():
    return {"status": "ok"}
