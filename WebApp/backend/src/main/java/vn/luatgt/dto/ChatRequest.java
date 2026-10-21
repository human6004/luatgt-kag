package vn.luatgt.dto;

import jakarta.validation.constraints.*;

public record ChatRequest(@NotBlank @Size(max=4000) String message, @Size(max=0) String contextId) {}
