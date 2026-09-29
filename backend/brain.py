from langgraph.graph import START, StateGraph, END
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_core.messages.utils import count_tokens_approximately
from PROMPTS import GUARD_SYSTEM, GUARD_HUMAN
from typing import TypedDict, Literal
from pydantic import BaseModel, Field



class WebState(TypedDict):
    url: str
    content: str
    metadata : str
    query :str
    is_safe : bool
    is_relevant : bool
    response: str
    error : str

class GaurdRail(BaseModel):
    is_safe : bool = Field(..., description="Indicates whether the content is safe or not")
    is_relevant : bool = Field(..., description="Indicates whether the content is relevant to the query or not")

import os
from pathlib import Path
from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)

groq_key = os.getenv("GROQ_API_KEY") or "gsk_dummy_placeholder"
model = ChatGroq(model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"), api_key=groq_key)
gaurdrail_model = model.with_structured_output(GaurdRail)


def count_web_tokens(state : WebState) -> Literal["exceed", "in_limit"]:
    try:
        num_tokens = count_tokens_approximately([state.get("content")])

        if num_tokens < 2000:
            return "in_limit"
        else:
            return "exceed"
        
    except Exception as e:
        return {"error" : f"Error at count_web_tokens {e}"}


async def evaluate_query(state : WebState) -> GaurdRail:
    try:
        system_message = SystemMessage(content=GUARD_SYSTEM)
        human_message = HumanMessage(content=GUARD_HUMAN.format(state.get("url"), state.get("query")))
        messages = [system_message, human_message]
        result = await gaurdrail_model.ainvoke(messages)
        return {"is_safe": result.is_safe, "is_relevant": result.is_relevant}
    except Exception as e:
        return {"error" : f"Error at evaluate_query {e}"}





    







# a system where if tokens in page is less that X then it is directly given to model, if not yhe we create a rag system with bm25 with 
# markdown chunking, using this we will make back and forth conversation for this extension along with observability using langsmith also 
# adding multi model capabilities, if any onw want to use this application they can use it lie stand alone by pulling from github