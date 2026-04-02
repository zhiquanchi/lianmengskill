"""CRUD operations for conversations using SQLAlchemy CRUD Plus."""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy_crud_plus import CRUDPlus

from .models import Conversation

_conversation = CRUDPlus(Conversation)


class ConversationCRUD:
    """CRUD operations for Conversation model."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def create_conversation(self, question: str, answer: str) -> Conversation:
        """Create a new conversation record."""
        conversation = Conversation(question=question, answer=answer)
        self.session.add(conversation)
        await self.session.commit()
        await self.session.refresh(conversation)
        return conversation

    async def get_conversations(
        self, skip: int = 0, limit: int = 100
    ) -> list[Conversation]:
        """Get paginated list of conversations."""
        rows = await _conversation.select_models_order(
            self.session,
            ["created_at"],
            ["desc"],
            limit=limit,
            offset=skip,
        )
        return list(rows)

    async def get_conversation_by_id(self, conversation_id: int) -> Conversation | None:
        """Get a conversation by ID."""
        return await _conversation.select_model(self.session, conversation_id)

    async def search_conversations(
        self, query: str, skip: int = 0, limit: int = 50
    ) -> list[Conversation]:
        """Search conversations by question or answer content."""
        conversations = await self.get_conversations(skip=skip, limit=limit)
        return [
            conv
            for conv in conversations
            if query.lower() in conv.question.lower()
            or query.lower() in conv.answer.lower()
        ]
