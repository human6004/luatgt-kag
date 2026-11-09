ALTER TABLE chat_messages ADD COLUMN conversation_id BINARY(16) NULL;
CREATE INDEX chat_conversation ON chat_messages(owner_id, conversation_id, created_at);
