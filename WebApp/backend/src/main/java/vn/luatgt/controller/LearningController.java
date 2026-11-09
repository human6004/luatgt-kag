package vn.luatgt.controller;

import jakarta.validation.Valid;
import java.util.*;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import vn.luatgt.dto.AnswerRequest;
import vn.luatgt.service.LearningService;

@RestController @RequestMapping("/api")
public class LearningController {
    private final LearningService service;
    public LearningController(LearningService service) { this.service=service; }
    @GetMapping("/question-sets/{setId}/questions/{questionId}/media") ResponseEntity<byte[]> studyMedia(@PathVariable UUID setId,@PathVariable UUID questionId) {
        var file=service.studyMedia(setId,questionId);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(file.mime())).header("X-Content-Type-Options","nosniff").cacheControl(CacheControl.noStore()).body(file.bytes());
    }
    @GetMapping("/exams/{id}/questions/{questionId}/media") ResponseEntity<byte[]> media(@PathVariable UUID id,@PathVariable UUID questionId,JwtAuthenticationToken auth) {
        var file=service.examMedia(id,questionId,auth);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(file.mime())).header("X-Content-Type-Options","nosniff").cacheControl(CacheControl.noStore()).body(file.bytes());
    }
    @PostMapping("/study/{questionId}/answer") Map<String,Object> study(@PathVariable UUID questionId,@Valid @RequestBody AnswerRequest choice,JwtAuthenticationToken auth) { return service.study(questionId,choice,auth); }
    @GetMapping("/progress") List<Map<String,Object>> progress(JwtAuthenticationToken auth,@RequestParam(required=false) UUID questionSetId) { return service.progress(auth,questionSetId); }
    @DeleteMapping("/progress") Map<String,Integer> resetProgress(JwtAuthenticationToken auth,@RequestParam UUID questionSetId) { return service.resetProgress(auth,questionSetId); }
    @PostMapping("/exams") Map<String,Object> start(JwtAuthenticationToken auth,@Valid @RequestBody(required=false) vn.luatgt.dto.StartExamRequest request) { return service.start(auth,request==null?null:request.ruleId()); }
    @GetMapping("/exams/{id}") Map<String,Object> exam(@PathVariable UUID id,JwtAuthenticationToken auth) { return service.exam(id,auth); }
    @PutMapping("/exams/{id}/answers/{questionId}") Map<String,Object> answer(@PathVariable UUID id,@PathVariable UUID questionId,@Valid @RequestBody AnswerRequest choice,JwtAuthenticationToken auth) { return service.answer(id,questionId,choice,auth); }
    @PostMapping("/exams/{id}/submit") Map<String,Object> submit(@PathVariable UUID id,JwtAuthenticationToken auth) { return service.submit(id,auth); }
    @GetMapping("/exams") List<Map<String,Object>> history(JwtAuthenticationToken auth) { return service.history(auth); }
}
