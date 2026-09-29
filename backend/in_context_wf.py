from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage, BaseMessage
from langgraph.graph.message import add_messages, RemoveMessage
from langgraph.graph import START, StateGraph, END
from PROMPTS import IN_CONTEXT_GEN_HUMAN, IN_CONTEXT_GEN_SYSTEM, CONTEXT_LIMIT_IF_SUMMARY, CONTEXT_LIMIT_IF_NOT_SUMMARY, CONTEXT_LIMIT_SYSTEM
from langchain_core.messages.utils import count_tokens_approximately, trim_messages
from typing import TypedDict, Annotated, Literal

import os
from pathlib import Path
from dotenv import load_dotenv
MAX_TOKEN_LIMIT = 4000

env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)

groq_key = os.getenv("GROQ_API_KEY") or "gsk_dummy_placeholder"
model = ChatGroq(model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"), api_key=groq_key)

class InContextState(TypedDict):
    url : str
    content : str
    query : str
    summary : str
    messages : Annotated[list[BaseMessage], add_messages]
    response : str
    error : str | None



def _token_count_helper(state : InContextState):
    try: 
        if state.get("summary"):
            num_tokens = count_tokens_approximately([state.get("summary")] + state.get("messages"))
        else:
            num_tokens = count_tokens_approximately(state.get("messages"))
    except Exception as e:
        num_tokens = 0
    return num_tokens

async def context_control_node(state : InContextState):
    remaining_messages = trim_messages(
        state["messages"],
        max_tokens=MAX_TOKEN_LIMIT,
        strategy="last",
        token_counter=count_tokens_approximately
    )


    remaining_ids = {msg.id for msg in remaining_messages}
    extra_msgs = [msg for msg in state["messages"] if msg.id not in remaining_ids]

    if not extra_msgs:
        return {}

    current_summary = state.get("summary", None)

    if current_summary:
        prompt = CONTEXT_LIMIT_IF_SUMMARY.format(current_summary = state.get("summary", " "), new_msgs_to_integrate = extra_msgs)
    else:
        prompt = CONTEXT_LIMIT_IF_NOT_SUMMARY.format(new_msgs_to_integrate = extra_msgs)

    summary = await model.ainvoke([SystemMessage(content=CONTEXT_LIMIT_SYSTEM), HumanMessage(content=prompt)])
    return {"messages" : [RemoveMessage(id = msg.id) for msg in extra_msgs], "summary" : summary.content}




async def generate_responce(state : InContextState):
    try:
        system_message = SystemMessage(content=IN_CONTEXT_GEN_SYSTEM)
        human_message = HumanMessage(content=IN_CONTEXT_GEN_HUMAN.format(url=state.get("url"), context=state.get("content"), summary = state.get("summary", " "), query=state.get("query")))
        messages = [system_message, human_message]
        result = await model.ainvoke(messages)
        return {"response" : result.content}
    except Exception as e:
        return {"error" : f"Error at generate_responce {e}"}

def token_cheker(state : InContextState) -> Literal["in_limit", "exceed"]:
    num_tokens = _token_count_helper(state)
    if num_tokens <= MAX_TOKEN_LIMIT:
        return "in_limit"
    else:
        return "exceed"

graph = StateGraph(InContextState)

graph.add_node("context_control_node", context_control_node)
graph.add_node("generate_responce", generate_responce)

graph.add_conditional_edges(START, token_cheker, {"in_limit" : "generate_responce", "exceed" : "context_control_node"})
graph.add_edge("context_control_node", "generate_responce")
graph.add_edge("generate_responce", END)

if __name__ == "__main__":
    print("complailing")
    graph.compile()
    print("complaied")