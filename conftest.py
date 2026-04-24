import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

# 测试使用内存数据库，避免依赖文件系统
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
