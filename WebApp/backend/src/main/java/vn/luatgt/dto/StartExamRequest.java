package vn.luatgt.dto;

import java.util.UUID;
import jakarta.validation.constraints.NotNull;

public record StartExamRequest(@NotNull UUID ruleId) {}
