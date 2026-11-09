package vn.luatgt.dto;

import jakarta.validation.constraints.*;
import java.util.UUID;

public record ChatRequest(@NotBlank @Size(max=4000) String message, @Size(max=0) String contextId, UUID conversationId) {
    public ChatRequest(String message,String contextId) { this(message,contextId,null); }
}
