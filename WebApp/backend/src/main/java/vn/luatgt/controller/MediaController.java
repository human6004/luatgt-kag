package vn.luatgt.controller;

import java.io.IOException;
import java.util.*;
import org.springframework.http.*;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import vn.luatgt.service.MediaService;

@RestController @RequestMapping("/api")
public class MediaController {
    private final MediaService service;
    public MediaController(MediaService service) { this.service=service; }
    @PostMapping("/admin/content/{id}/media") Map<String,Object> upload(@PathVariable UUID id,@RequestPart MultipartFile file) throws IOException { return service.upload(id,file); }
    @PostMapping("/admin/signs/images-zip") Map<String,Object> zip(@RequestPart MultipartFile file,@RequestPart(required=false) Map<UUID,Long> replacements) throws IOException { return service.zip(file,"signs",null,replacements); }
    @PostMapping("/admin/questions/images-zip") Map<String,Object> questionsZip(@RequestPart MultipartFile file,@RequestParam(required=false) UUID questionSetId,@RequestPart(required=false) Map<UUID,Long> replacements) throws IOException { return service.zip(file,"questions",questionSetId,replacements); }
    @GetMapping({"/content/{id}/media","/admin/content/{id}/media"}) ResponseEntity<byte[]> download(@PathVariable UUID id,JwtAuthenticationToken auth) throws IOException {
        boolean canReadDrafts=auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN")||a.getAuthority().equals("ROLE_POLICE"));
        var result=service.download(id,canReadDrafts);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(result.mime())).header("X-Content-Type-Options","nosniff")
            .header("Content-Security-Policy","sandbox; default-src 'none'")
            .header("Content-Disposition","attachment; filename=\""+id+(result.mime().equals("application/pdf")?".pdf":".image")+"\"")
            .cacheControl(CacheControl.noStore()).body(result.bytes());
    }
}
