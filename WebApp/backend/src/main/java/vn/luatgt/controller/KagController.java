package vn.luatgt.controller;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import java.util.*;
import org.springframework.web.bind.annotation.*;
import vn.luatgt.dto.*;
import vn.luatgt.service.*;
@RestController @RequestMapping("/api")
public class KagController {
    private final KagSchema schema; private final LegalUnitService units; private final InfrastructureService infrastructure;
    public KagController(KagSchema schema,LegalUnitService units,InfrastructureService infrastructure) { this.schema=schema; this.units=units; this.infrastructure=infrastructure; }
    @GetMapping("/admin/kag/status") Map<String,Object> status() { return infrastructure.kagStatus(); }
    @GetMapping("/admin/kag/serving") org.springframework.http.ResponseEntity<JsonNode> serving(@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Danh sách đồ thị không nhận tham số");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.serving());
    }
    @PostMapping("/admin/kag/serving/{action:preview|activate}") org.springframework.http.ResponseEntity<JsonNode> servingAction(
            @PathVariable String action,@RequestBody JsonNode change,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Kích hoạt đồ thị không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.servingAction(action,change));
    }
    @GetMapping("/admin/kag/config") org.springframework.http.ResponseEntity<JsonNode> configuration(
            @RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,"Cấu hình chỉ đọc không nhận tham số hoặc nội dung yêu cầu");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.kagConfiguration());
    }
    @GetMapping("/admin/kag/sample") JsonNode sample(@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,"Inspection không nhận truy vấn tùy ý");
        return infrastructure.sampleInspection();
    }
    @GetMapping("/admin/kag/config/models") org.springframework.http.ResponseEntity<JsonNode> llmCredentials(
            @RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw vn.luatgt.exception.ApiErrors.bad("Cấu hình model không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.llmCredentials(null));
    }
    @PostMapping("/admin/kag/config/models") org.springframework.http.ResponseEntity<JsonNode> saveLLMCredentials(
            @Valid @RequestBody LLMCredentialsChangeRequest change,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Cấu hình model không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.llmCredentials(change));
    }
    @GetMapping("/admin/kag/config/retrieval") org.springframework.http.ResponseEntity<JsonNode> chatRetrieval(
            @RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw vn.luatgt.exception.ApiErrors.bad("Cấu hình Retrieval không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.chatRetrievalConfiguration());
    }
    @PostMapping("/admin/kag/config/models/{role:chat|embedding}/{action:test|apply}")
    org.springframework.http.ResponseEntity<JsonNode> modelAction(@PathVariable String role,@PathVariable String action,
            @Valid @RequestBody ModelConfigActionRequest change,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Thao tác model không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
            .body(infrastructure.modelAction(role,action,change));
    }
    @PostMapping("/admin/kag/config/retrieval/{action:save|apply|restore}") org.springframework.http.ResponseEntity<JsonNode> chatRetrievalChange(
            @PathVariable String action,@Valid @RequestBody ChatRetrievalChangeRequest request,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Cấu hình Retrieval không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.changeChatRetrieval(action,request));
    }
    @GetMapping("/admin/kag/pipeline") JsonNode pipeline() { return infrastructure.pipelineStatus(); }
    @GetMapping("/admin/kag/builder/status") JsonNode builderStatus() { return infrastructure.builderStatus(); }
    @GetMapping("/admin/kag/builder/projects")
    org.springframework.http.ResponseEntity<JsonNode> builderProjects(@RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw vn.luatgt.exception.ApiErrors.bad("Danh sách project không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.builderProjects());
    }
    @GetMapping("/admin/kag/builder/configuration")
    org.springframework.http.ResponseEntity<JsonNode> builderConfiguration(@RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw vn.luatgt.exception.ApiErrors.bad("Cấu hình Builder không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.builderConfiguration());
    }
    @GetMapping("/admin/kag/graph/{projectId}")
    org.springframework.http.ResponseEntity<JsonNode> graphProject(@PathVariable int projectId,
            @RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(projectId<1||!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw vn.luatgt.exception.ApiErrors.bad("Xem graph chỉ nhận ID project");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.graphProject(projectId));
    }
    @GetMapping("/admin/kag/sources/{projectId}/{runId}")
    org.springframework.http.ResponseEntity<JsonNode> graphSources(@PathVariable int projectId,@PathVariable String runId,
            @RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)throw vn.luatgt.exception.ApiErrors.bad("Nguồn đồ thị chỉ nhận project và phiên đã xác minh");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.graphSources(projectId,runId));
    }
    @GetMapping("/admin/kag/builder/structure")
    org.springframework.http.ResponseEntity<JsonNode> builderStructure(@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Trạng thái cấu trúc không nhận tham số");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.builderStructure(null,null));
    }
    @PostMapping("/admin/kag/builder/structure/{action:preview|apply}")
    org.springframework.http.ResponseEntity<JsonNode> builderStructureAction(@PathVariable String action,@RequestBody JsonNode change,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Chuẩn bị cấu trúc không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.accepted().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.builderStructure(action,change));
    }
    @PostMapping("/admin/kag/builder/configuration")
    org.springframework.http.ResponseEntity<JsonNode> saveBuilderConfiguration(@RequestBody JsonNode change,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Cấu hình Builder không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.accepted().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.saveBuilderConfiguration(change));
    }
    @PostMapping("/admin/kag/builder/selection")
    org.springframework.http.ResponseEntity<JsonNode> previewBuilderSelection(@RequestBody JsonNode change,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Xem trước phạm vi không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.accepted().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.previewBuilderSelection(change));
    }
    @GetMapping("/admin/kag/builder/clear")
    org.springframework.http.ResponseEntity<JsonNode> builderClear(@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Trạng thái xóa không nhận tham số");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.builderClear(null,null));
    }
    @PostMapping("/admin/kag/builder/clear/{action:preview|apply}")
    org.springframework.http.ResponseEntity<JsonNode> builderClearAction(@PathVariable String action,@RequestBody JsonNode change,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Xóa dữ liệu không nhận tham số tùy ý");
        return org.springframework.http.ResponseEntity.accepted().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.builderClear(action,change));
    }
    @PostMapping("/admin/kag/builder/preflight")
    org.springframework.http.ResponseEntity<JsonNode> checkBuilderReadiness(@RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw vn.luatgt.exception.ApiErrors.bad("Kiểm sẵn sàng không nhận nội dung hoặc tham số tùy ý");
        return org.springframework.http.ResponseEntity.accepted().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.checkBuilderReadiness());
    }
    @GetMapping("/admin/kag/builder/inputs") JsonNode builderInputs(@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,"Đầu vào Builder không nhận đường dẫn hoặc tham số tùy ý");
        return infrastructure.builderInputs();
    }
    @GetMapping("/admin/kag/dataset/{group}")
    org.springframework.http.ResponseEntity<JsonNode> dataset(@PathVariable String group,
            @RequestParam(defaultValue="0") int offset,@RequestParam(defaultValue="25") int limit,@RequestParam Map<String,String> parameters) {
        if(!Set.of("offset","limit").containsAll(parameters.keySet()))throw vn.luatgt.exception.ApiErrors.bad("Xem nguồn chỉ nhận loại và phân trang");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.dataset(group,offset,limit));
    }
    @PostMapping("/admin/kag/builder/inputs")
    org.springframework.http.ResponseEntity<JsonNode> checkBuilderInputs(@RequestParam Map<String,String> parameters,jakarta.servlet.http.HttpServletRequest request) {
        if(!parameters.isEmpty()||request.getContentLengthLong()>0||request.getHeader("Transfer-Encoding")!=null)
            throw vn.luatgt.exception.ApiErrors.bad("Kiểm nguồn không nhận đường dẫn, tham số hoặc nội dung yêu cầu");
        return org.springframework.http.ResponseEntity.accepted().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.checkBuilderInputs());
    }
    @PostMapping("/admin/kag/builder/build") @ResponseStatus(org.springframework.http.HttpStatus.ACCEPTED)
    JsonNode build(@Valid @RequestBody BuilderRunRequest request,@RequestHeader(value="If-Match",required=false) String revision) { return infrastructure.builderAction("build",request.runId(),revision); }
    @PostMapping("/admin/kag/builder/stop") @ResponseStatus(org.springframework.http.HttpStatus.ACCEPTED)
    JsonNode stop(@Valid @RequestBody BuilderRunRequest request) { return infrastructure.builderAction("stop",request.runId()); }
    @PostMapping("/admin/kag/builder/resume") @ResponseStatus(org.springframework.http.HttpStatus.ACCEPTED)
    JsonNode resume(@Valid @RequestBody BuilderRunRequest request,@RequestHeader(value="If-Match",required=false) String revision) { return infrastructure.builderAction("resume",request.runId(),revision); }
    @PostMapping("/admin/kag/builder/abandon") @ResponseStatus(org.springframework.http.HttpStatus.ACCEPTED)
    JsonNode abandon(@Valid @RequestBody BuilderRunRequest request,@RequestHeader(value="If-Match",required=false) String revision) { return infrastructure.builderAction("abandon",request.runId(),revision); }
    @GetMapping("/admin/kag/benchmark/datasets") JsonNode datasets() { return infrastructure.benchmarkDatasets(); }
    @PostMapping("/admin/kag/retrieve") JsonNode retrieve(@Valid @RequestBody KagRetrieveRequest request) { return infrastructure.retrieve(request); }
    @PostMapping("/admin/kag/graph/{projectId}/{runId}/retrieve")
    org.springframework.http.ResponseEntity<JsonNode> trialGraph(@PathVariable int projectId,@PathVariable String runId,
            @Valid @RequestBody KagRetrieveRequest request,@RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty())throw vn.luatgt.exception.ApiErrors.bad("Thử đồ thị chỉ nhận project, phiên dựng và câu hỏi");
        return org.springframework.http.ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(infrastructure.trialGraph(projectId,runId,request));
    }
    @GetMapping("/admin/kag/schema") Map<String,Object> schema() { return Map.of("identity",schema.identity(),"contract",schema.contract()); }
    @GetMapping("/admin/units") List<Map<String,Object>> admin(@RequestParam(required=false) String docId) { return units.list(docId,true); }
    @GetMapping("/units") List<Map<String,Object>> list(@RequestParam String docId) { return units.list(docId,false); }
    @PostMapping("/admin/imports/units/preview") List<Map<String,Object>> preview(@Valid @RequestBody ImportRequest request) { return units.preview(request); }
    @PostMapping("/admin/imports/units/confirm") Map<String,Integer> confirm(@Valid @RequestBody ImportRequest request) { return units.confirm(request); }
    @PutMapping("/admin/units/{id}") Map<String,Object> edit(@PathVariable UUID id,@Valid @RequestBody ContentChangeRequest request) { return units.edit(id,request); }
    @PostMapping("/admin/units/{id}/publication") Map<String,Object> publish(@PathVariable UUID id,@Valid @RequestBody PublicationRequest request) { return units.publish(id,request); }
}
