package vn.luatgt.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.*;
import java.util.List;

public record ImportRequest(@NotEmpty @Size(max=ImportRequest.MAX_ROWS) List<JsonNode> rows, boolean updateExisting) {
    public static final int MAX_ROWS=5000;
}
