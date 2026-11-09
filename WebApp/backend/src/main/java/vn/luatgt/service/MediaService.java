package vn.luatgt.service;

import java.io.*;
import java.util.*;
import java.util.zip.*;
import javax.imageio.ImageIO;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.integration.ObjectStorage;
import vn.luatgt.model.Content;
import vn.luatgt.repository.ContentRepository;

@Service
public class MediaService {
    private final ContentRepository contents; private final ContentService data; private final ObjectStorage storage;
    public MediaService(ContentRepository contents,ContentService data,ObjectStorage storage) { this.contents=contents; this.data=data; this.storage=storage; }
    public record Download(byte[] bytes,String mime) {}
    private String imageMime(byte[] bytes) {
        if(bytes.length>5*1024*1024) throw ApiErrors.bad("Ảnh vượt 5 MB");
        try(var stream=ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers=ImageIO.getImageReaders(stream);
            if(!readers.hasNext()) throw ApiErrors.bad("Ảnh cần là PNG hoặc JPEG hợp lệ");
            var reader=readers.next();
            try {
                reader.setInput(stream); String format=reader.getFormatName().toLowerCase(Locale.ROOT);
                if(!Set.of("png","jpeg","jpg").contains(format)||reader.getWidth(0)>4096||reader.getHeight(0)>4096) throw ApiErrors.bad("Ảnh PNG/JPEG tối đa 4096×4096");
                if(reader.read(0)==null) throw ApiErrors.bad("Ảnh không đọc được");
                return format.equals("png")?"image/png":"image/jpeg";
            } finally { reader.dispose(); }
        } catch(IOException e) { throw ApiErrors.bad("Ảnh không đọc được"); }
    }
    private void attach(Content c,byte[] bytes) {
        data.remember(c);
        var n=data.read(c); boolean document=c.kind.equals("documents"); String mime;
        if(document) {
            if(bytes.length>20*1024*1024||bytes.length<5||!new String(bytes,0,5,java.nio.charset.StandardCharsets.US_ASCII).equals("%PDF-")) throw ApiErrors.bad("Cần tệp PDF tối đa 20 MB");
            mime="application/pdf";
        } else mime=imageMime(bytes);
        // ponytail: replacing an asset can leave an unreferenced object; add a bucket cleanup job when storage grows.
        n.put(document?"fileKey":"imageKey",storage.put(bytes,mime)); n.put(document?"fileMime":"imageMime",mime);
        n.put("reviewed",false);if(c.kind.equals("signs"))n.put("image_status","unverified");c.data=data.write(n); c.published=false; contents.save(c);data.sync(c);
    }
    @Transactional
    public Map<String,Object> upload(UUID id,MultipartFile file) throws IOException {
        var c=contents.findById(id).orElseThrow(ApiErrors::missing);
        if(file.isEmpty()||file.getSize()>20*1024*1024) throw ApiErrors.bad("Tệp trống hoặc quá lớn");
        attach(c,file.getBytes()); contents.flush(); return data.view(c,true);
    }
    @Transactional
    public Map<String,Object> zip(MultipartFile file) throws IOException {
        return zip(file,"signs");
    }
    @Transactional
    public Map<String,Object> zip(MultipartFile file,String kind) throws IOException {
        return zip(file,kind,null);
    }
    @Transactional
    public Map<String,Object> zip(MultipartFile file,String kind,UUID questionSetId) throws IOException {
        return zip(file,kind,questionSetId,Map.of());
    }
    @Transactional
    public Map<String,Object> zip(MultipartFile file,String kind,UUID questionSetId,Map<UUID,Long> replacements) throws IOException {
        if(replacements==null) replacements=Map.of();
        if(replacements.size()>1000||replacements.values().stream().anyMatch(v->v==null||v<0)) throw ApiErrors.bad("Xác nhận thay ảnh không hợp lệ");
        if(!Set.of("signs","questions").contains(kind)) throw ApiErrors.bad("ZIP chỉ dùng cho biển báo/câu hỏi");
        if(file.isEmpty()||file.getSize()>20*1024*1024) throw ApiErrors.bad("ZIP tối đa 20 MB");
        var matched=new ArrayList<String>(); var unmatched=new ArrayList<String>(); var seen=new HashSet<String>();
        var kept=new ArrayList<String>();
        long total=0; int count=0;
        // Validate the entire archive before uploading: no partial DB import on malformed input.
        var assets=new LinkedHashMap<Content,byte[]>();
        var signs=contents.findByKindOrderByExternalId(kind).stream().filter(c->questionSetId==null||data.read(c).path("questionSetId").asText().equals(questionSetId.toString())).toList();
        try(var zip=new ZipInputStream(file.getInputStream())) {
            ZipEntry entry;
            while((entry=zip.getNextEntry())!=null) {
                if(++count>1000) throw ApiErrors.bad("ZIP vượt 1000 mục");
                if(entry.isDirectory()) continue;
                String path=entry.getName().replace('\\','/');
                if(path.startsWith("/")||Arrays.asList(path.split("/")).contains("..")) throw ApiErrors.bad("Đường dẫn ZIP không hợp lệ");
                String name=path.substring(path.lastIndexOf('/')+1);
                if(!name.toLowerCase(Locale.ROOT).matches(".+\\.(png|jpe?g)")) throw ApiErrors.bad("ZIP chỉ chứa PNG/JPEG");
                byte[] bytes=zip.readNBytes(5*1024*1024+1); total+=bytes.length;
                if(bytes.length>5*1024*1024||total>50*1024*1024) throw ApiErrors.bad("ZIP giải nén vượt giới hạn");
                imageMime(bytes);
                String code=name.substring(0,name.lastIndexOf('.'));
                if(!seen.add(code.toUpperCase(Locale.ROOT))) throw ApiErrors.bad("Trùng tên ảnh: "+code);
                var candidates=signs.stream().filter(c -> (kind.equals("signs")?data.read(c).path("code").asText():data.read(c).path("sourceExternalId").asText(c.externalId)).equalsIgnoreCase(code)).toList();
                if(candidates.size()!=1) { unmatched.add(name); continue; }
                var candidate=candidates.getFirst();
                if(data.read(candidate).hasNonNull("imageKey")) {
                    Long approvedVersion=replacements.get(candidate.id);
                    if(approvedVersion==null) { kept.add(code); continue; }
                    if(approvedVersion!=candidate.version) throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.CONFLICT,"Ảnh hoặc câu hỏi đã thay đổi. Xem lại ảnh cũ và xác nhận lại: "+code);
                }
                assets.put(candidate,bytes); matched.add(code);
            }
        } catch(ZipException e) { throw ApiErrors.bad("Tệp ZIP lỗi"); }
        if(count==0) throw ApiErrors.bad("ZIP trống hoặc không hợp lệ");
        assets.forEach(this::attach); contents.flush(); return Map.of("matched",matched,"unmatched",unmatched,"kept",kept);
    }
    public Download download(UUID id,boolean canReadDrafts) {
        var c=contents.findById(id).orElseThrow(ApiErrors::missing); var n=data.read(c);
        if(!canReadDrafts&&(!c.published||!data.isEffective(c))) throw ApiErrors.missing();
        if(!canReadDrafts&&c.kind.equals("signs")&&!n.path("image_status").asText().equals("verified"))throw ApiErrors.missing();
        String key=c.kind.equals("documents")?"fileKey":"imageKey", mime=c.kind.equals("documents")?"fileMime":"imageMime";
        if(!n.hasNonNull(key)) throw ApiErrors.missing();
        return new Download(storage.get(n.path(key).asText()),n.path(mime).asText("application/octet-stream"));
    }
}
