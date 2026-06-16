import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

# 测试使用内存数据库，避免依赖文件系统
# 强制使用内存数据库，防止 load_dotenv 注入的 DATABASE_URL 污染测试
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
