package vn.luatgt.dto;

import jakarta.validation.constraints.*;

public record AnswerRequest(@NotNull @Min(0) @Max(3) Integer selected,java.util.UUID questionSetId) {
    public AnswerRequest(Integer selected) {this(selected,null);}
}
