"""Web search tool with structured citation support."""
from typing import Dict, Any, List
from settings import get_tavily_client


class WebSearchTool:
    def __init__(self) -> None:
        self._client = get_tavily_client()

    def search(self, query: str) -> Dict[str, Any]:
        """Return structured search results with citation metadata."""
        try:
            response: Dict[str, Any] = self._client.search(
                query=query,
                search_depth="advanced",
                max_results=5
            )
            results = response.get("results", [])
            if not results:
                return {"results": [], "formatted": "No search results found."}

            docs = []
            citations = []
            for idx, item in enumerate(results, start=1):
                title = item.get("title", "Untitled")
                url = item.get("url", "No URL")
                content = item.get("content", "")
                docs.append(f"[{idx}] Source: {title} ({url})\n{content}\n---")
                citations.append({
                    "index": idx,
                    "title": title,
                    "url": url,
                    "snippet": content[:200] + "..." if len(content) > 200 else content
                })

            return {
                "results": citations,
                "formatted": "\n".join(docs)
            }
        except Exception as e:
            return {"results": [], "formatted": f"Search failed: {str(e)}"}

    def search_and_format(self, query: str) -> str:
        """Legacy plain-text search for non-citation routes."""
        return self.search(query)["formatted"]