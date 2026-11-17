ALTER TABLE chat_messages ADD COLUMN deleted_at DATETIME(6) NULL;
ALTER TABLE chat_messages ADD COLUMN conversation_title VARCHAR(200) NULL;
