"""Safe math tool."""
import ast
import operator
import re
from typing import Optional, Union

class SafeCalculator:
    _OPERATORS = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
        ast.Pow: operator.pow,
        ast.USub: operator.neg,
        ast.UAdd: operator.pos
    }
    MATH_PATTERN = re.compile(r'^[0-9_.\s+\-*/()**]+$')
    
    @classmethod
    def is_math_expression(cls, text: str) -> bool:
        cleaned = text.strip()
        if not cleaned or not cls.MATH_PATTERN.match(cleaned):
            return False
        if cleaned.isdigit() or re.match(r'^\d+\.\d+$', cleaned):
            return False
        return True
    
    @classmethod
    def evaluate(cls, expression: str) -> Optional[str]:
        try:
            node = ast.parse(expression.strip(), mode='eval')
            result = cls._eval_node(node.body)
            return str(result)
        except Exception as e:
            return f"Error: {str(e)}"
    
    @classmethod
    def _eval_node(cls, node: ast.AST) -> Union[int, float]:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return node.value
            raise TypeError("Invalid constant.")
        elif isinstance(node, ast.BinOp):
            left = cls._eval_node(node.left)
            right = cls._eval_node(node.right)
            op_type = type(node.op)
            if op_type in cls._OPERATORS:
                if op_type == ast.Div and right == 0:
                    raise ZeroDivisionError("Division by zero.")
                if op_type == ast.Pow and (abs(left) > 10000 or right > 1000):
                    raise ValueError("Exponent too large.")
                return cls._OPERATORS[op_type](left, right)
        elif isinstance(node, ast.UnaryOp):
            operand = cls._eval_node(node.operand)
            op_type = type(node.op)
            if op_type in cls._OPERATORS:
                return cls._OPERATORS[op_type](operand)
        raise ValueError(f"Unsupported: {type(node).__name__}")