ALTER TABLE chat_messages ADD COLUMN context_summary TEXT NULL;
ALTER TABLE chat_messages ADD COLUMN context_through BINARY(16) NULL;
