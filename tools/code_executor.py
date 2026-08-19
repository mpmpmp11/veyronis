"""Safe code execution sandbox for VEYRONIS."""
import ast
import os
import subprocess
import sys
import tempfile
from typing import Tuple


class CodeExecutor:
    BANNED_MODULES = {
        "os", "sys", "subprocess", "socket", "urllib", "requests", "http",
        "ftplib", "smtplib", "shutil", "pathlib", "pickle", "marshal",
        "ctypes", "threading", "multiprocessing", "webbrowser", "tkinter",
        "pyautogui", "pynput"
    }

    BANNED_BUILTINS = {"open", "eval", "exec", "compile", "__import__", "input", "exit", "quit"}

    @classmethod
    def _check_ast(cls, code: str) -> Tuple[bool, str]:
        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return False, f"Syntax error: {e}"

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    root = alias.name.split(".")[0]
                    if root in cls.BANNED_MODULES:
                        return False, f"Import '{alias.name}' is not allowed in sandbox."
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    root = node.module.split(".")[0]
                    if root in cls.BANNED_MODULES:
                        return False, f"Import from '{node.module}' is not allowed in sandbox."
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in cls.BANNED_BUILTINS:
                    return False, f"Function '{node.func.id}' is not allowed in sandbox."
        return True, ""

    @classmethod
    def run(cls, code: str) -> dict:
        safe, reason = cls._check_ast(code)
        if not safe:
            return {"success": False, "output": "", "error": reason}

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(code)
            tmp_path = f.name

        try:
            result = subprocess.run(
                [sys.executable, tmp_path],
                capture_output=True,
                text=True,
                timeout=5
            )
            return {
                "success": result.returncode == 0,
                "output": result.stdout.rstrip("\n"),
                "error": result.stderr.rstrip("\n")
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "output": "", "error": "Execution timed out (5 second limit)."}
        except Exception as e:
            return {"success": False, "output": "", "error": str(e)}
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass