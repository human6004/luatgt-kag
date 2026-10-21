package vn.luatgt.controller;

import jakarta.validation.Valid;
import java.util.*;
import org.springframework.http.*;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import vn.luatgt.dto.ChatRequest;
import vn.luatgt.service.AuthService;
import vn.luatgt.service.ChatService;

@RestController @RequestMapping("/api/chat")
public class ChatController {
    private final ChatService service;
    public ChatController(ChatService service) { this.service=service; }
    @PostMapping Map<String,Object> ask(@Valid @RequestBody ChatRequest input,JwtAuthenticationToken auth) { return service.ask(AuthService.user(auth),input); }
    @PostMapping(value="/stream",produces=MediaType.TEXT_EVENT_STREAM_VALUE)
    ResponseEntity<StreamingResponseBody> stream(@Valid @RequestBody ChatRequest input,JwtAuthenticationToken auth,@RequestParam(defaultValue="false") boolean progress) {
        var owner=AuthService.user(auth);
        return ResponseEntity.ok().contentType(MediaType.TEXT_EVENT_STREAM).cacheControl(CacheControl.noStore()).header("X-Accel-Buffering","no").body(progress?service.progress(owner,input):service.stream(owner,input));
    }
    @PostMapping("/{id}/stop") Map<String,Object> stop(@PathVariable UUID id,JwtAuthenticationToken auth) {return service.stop(AuthService.user(auth),id);}
    @GetMapping List<Map<String,Object>> history(JwtAuthenticationToken auth) { return service.history(AuthService.user(auth)); }
}
