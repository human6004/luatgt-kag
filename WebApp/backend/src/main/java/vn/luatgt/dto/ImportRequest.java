package vn.luatgt.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.*;
import java.util.List;
import java.util.UUID;

public record ImportRequest(@NotEmpty @Size(max=ImportRequest.MAX_ROWS) List<JsonNode> rows, boolean updateExisting, UUID questionSetId) {
    public static final int MAX_ROWS=5000;
    public ImportRequest(List<JsonNode> rows,boolean updateExisting) {this(rows,updateExisting,null);}
}
