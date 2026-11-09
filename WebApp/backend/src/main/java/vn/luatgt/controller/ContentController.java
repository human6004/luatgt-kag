package vn.luatgt.controller;

import jakarta.validation.Valid;
import java.util.*;
import org.springframework.web.bind.annotation.*;
import vn.luatgt.dto.ContentChangeRequest;
import vn.luatgt.dto.ImportRequest;
import vn.luatgt.dto.PublicationRequest;
import vn.luatgt.dto.BatchPublicationRequest;
import vn.luatgt.service.ContentService;

@RestController @RequestMapping("/api")
public class ContentController {
    private final ContentService service;
    public ContentController(ContentService service) { this.service=service; }
    @GetMapping("/{kind:questions|signs|documents}") List<Map<String,Object>> list(@PathVariable String kind,@RequestParam(required=false) Integer chapter,@RequestParam(required=false) UUID questionSetId) { return service.list(kind,chapter,questionSetId); }
    @GetMapping("/admin/{kind:questions|signs|documents}") List<Map<String,Object>> admin(@PathVariable String kind) { return service.admin(kind); }
    @PostMapping("/admin/imports/{kind}/preview") List<Map<String,Object>> preview(@PathVariable String kind,@Valid @RequestBody ImportRequest input) { return service.preview(kind,input); }
    @PostMapping("/admin/imports/{kind}/confirm") Map<String,Integer> confirm(@PathVariable String kind,@Valid @RequestBody ImportRequest input) { return service.confirm(kind,input); }
    @PutMapping("/admin/content/{id}") Map<String,Object> edit(@PathVariable UUID id,@Valid @RequestBody ContentChangeRequest input) { return service.edit(id,input); }
    @PostMapping("/admin/content/{id}/publication") Map<String,Object> publish(@PathVariable UUID id,@Valid @RequestBody PublicationRequest input) { return service.publish(id,input); }
    @PostMapping("/admin/{kind:questions|signs}/publication-batch") void batch(@PathVariable String kind,@Valid @RequestBody BatchPublicationRequest input) { service.batchPublication(kind,input); }
    @DeleteMapping("/admin/questions/{id}") void deleteQuestion(@PathVariable UUID id,@RequestParam long version) { service.deleteQuestion(id,version); }
}
