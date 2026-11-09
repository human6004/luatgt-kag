package vn.luatgt.service;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.LocalDate;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.luatgt.dto.ContentChangeRequest;
import vn.luatgt.dto.ImportRequest;
import vn.luatgt.dto.PublicationRequest;
import vn.luatgt.dto.BatchPublicationRequest;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.model.Content;
import vn.luatgt.repository.ContentRepository;
import vn.luatgt.repository.ContentHistoryRepository;
import vn.luatgt.repository.LawRelationRepository;
import vn.luatgt.model.ContentHistory;

@Service
public class ContentService {
    private final ContentRepository contents; private final ObjectMapper json;
    private final ContentHistoryRepository history; private final LawRelationRepository relations;
    private final KagSchema schema;
    private final vn.luatgt.repository.LegalUnitRepository units;
    private final vn.luatgt.repository.LearningCatalogRepository bank;
    private final vn.luatgt.repository.SignCatalogRepository signs;
    public ObjectMapper mapper() { return json; }
    public ContentService(ContentRepository contents,ObjectMapper json,ContentHistoryRepository history,LawRelationRepository relations,KagSchema schema,vn.luatgt.repository.LegalUnitRepository units,vn.luatgt.repository.LearningCatalogRepository bank,vn.luatgt.repository.SignCatalogRepository signs) { this.contents=contents; this.json=json; this.history=history; this.relations=relations; this.schema=schema; this.units=units;this.bank=bank;this.signs=signs; }
    public void remember(Content c) { var h=new ContentHistory(); h.contentId=c.id; h.contentVersion=c.version; h.data=c.data; h.published=c.published; history.save(h); }
    public boolean isEffective(Content c) {
        if(!effective(read(c))) return false;
        if(c.kind.equals("signs")) {
            var n=read(c); var doc=contents.findByKindAndExternalId("documents",n.path("doc_id").asText());
            var unit=units.findByUnitId(n.path("unit_id").asText());
            return doc.isPresent()&&doc.get().published&&isEffective(doc.get())&&unit.isPresent()&&unit.get().published&&unit.get().documentId.equals(doc.get().id);
        }
        return !c.kind.equals("documents")||relations.findAll().stream().noneMatch(r -> r.predecessor.equals(c.id)&&r.type.equals("REPLACES")&&!r.effectiveDate.isAfter(LocalDate.now())&&contents.findById(r.successor).map(next -> next.published&&effective(read(next))).orElse(false));
    }
    public static void kind(String kind) { if(!Set.of("questions","signs","documents").contains(kind)) throw ApiErrors.bad("Loại dữ liệu không hợp lệ"); }
    public ObjectNode read(Content c) { try { var n=(ObjectNode)json.readTree(c.data);return c.kind.equals("signs")?signs.read(c,n):n; } catch(Exception e) { throw new IllegalStateException(e); } }
    public void sync(Content c) {
        contents.flush();
        try { var n=(ObjectNode)json.readTree(c.data);if(c.kind.equals("signs"))signs.sync(c,n);else if(c.kind.equals("questions")&&c.published)bank.publish(c,n); }
        catch(com.fasterxml.jackson.core.JsonProcessingException e) {throw new IllegalStateException(e);}
    }
    public String write(JsonNode data) { try { return json.writeValueAsString(data); } catch(Exception e) { throw new IllegalStateException(e); } }
    public static String text(ObjectNode n,String field,int max,boolean required) {
        JsonNode value=n.get(field);
        if(value!=null && !value.isNull() && !value.isTextual()) throw ApiErrors.bad(field+": cần chuỗi");
        String s=value==null||value.isNull()?"":value.asText().trim();
        if(s.length()>max || required && s.isBlank()) throw ApiErrors.bad(field+": trống hoặc quá dài");
        n.put(field,s); return s;
    }
    public static void alias(ObjectNode n,String target,String source) { if(!n.has(target)&&n.has(source)) n.set(target,n.get(source)); }
    private static void sourceAlias(ObjectNode n,String target,String source) {
        if(n.has(target)&&n.has(source)&&!n.get(target).equals(n.get(source))) throw ApiErrors.bad(target+" và "+source+" không khớp");
        alias(n,target,source); alias(n,source,target);
    }
    private static void sourceText(ObjectNode n,String field,int max,boolean required) {
        var value=n.get(field);
        if(value==null||value.isNull()) { if(required) throw ApiErrors.bad(field+": thiếu dữ liệu nguồn"); return; }
        if(!value.isTextual()||value.asText().length()>max||required&&value.asText().isBlank()) throw ApiErrors.bad(field+": trống hoặc quá dài");
    }
    public static void date(ObjectNode n,String key,boolean required) {
        if(!n.hasNonNull(key)||n.path(key).asText().isBlank()) { if(required) throw ApiErrors.bad(key+": thiếu ngày"); if(n.has(key)&&n.path(key).asText().isBlank()) n.putNull(key); return; }
        try { LocalDate.parse(n.get(key).textValue()); } catch(Exception e) { throw ApiErrors.bad(key+": phải là YYYY-MM-DD"); }
    }
    public ObjectNode validate(String kind,JsonNode input,boolean publish) {
        kind(kind);
        if(!input.isObject()) throw ApiErrors.bad("Mỗi dòng cần là object JSON");
        ObjectNode n=schema.normalize(kind,(ObjectNode)input);
        if(write(n).length()>50_000) throw ApiErrors.bad("Dòng dữ liệu quá lớn");
        n.remove(List.of("published","version","id"));
        if(n.hasNonNull("reviewed")&&!n.get("reviewed").isBoolean()) throw ApiErrors.bad("reviewed: phải là boolean");
        if(kind.equals("questions")) {
            alias(n,"externalId","code"); alias(n,"text","question"); alias(n,"correctAnswer","answer");
            text(n,"externalId",250,true); text(n,"text",5000,true);
            sourceText(n,"sourceExternalId",250,false);
            alias(n,"choiceMode","choice_mode");if(n.hasNonNull("choiceMode")&&!n.path("choiceMode").asText().equals("single"))throw ApiErrors.bad("Hiện chỉ hỗ trợ câu hỏi chọn một đáp án");
            if(n.hasNonNull("questionSetId")) try {bank.set(UUID.fromString(n.path("questionSetId").asText()));}catch(IllegalArgumentException e){throw ApiErrors.bad("questionSetId: UUID không hợp lệ");}
            if(n.hasNonNull("number")&&(!n.path("number").canConvertToInt()||!n.path("number").isIntegralNumber()||n.path("number").asInt()<1)) throw ApiErrors.bad("number: cần số thứ tự dương trong bộ");
            if(!n.path("chapter").isIntegralNumber() || !n.path("chapter").canConvertToInt() || n.path("chapter").asInt()<1 || n.path("chapter").asInt()>32767) throw ApiErrors.bad("chapter: cần số nguyên từ 1 đến 32767");
            var options=n.path("options");
            if(!options.isArray() || options.size()<2 || options.size()>4) throw ApiErrors.bad("options: cần 2–4 đáp án");
            for(var option:options) if(!option.isTextual() || option.asText().isBlank() || option.asText().length()>3000) throw ApiErrors.bad("Đáp án trống hoặc quá dài");
            if(n.hasNonNull("correctAnswer") && (!n.get("correctAnswer").isIntegralNumber() || !n.get("correctAnswer").canConvertToInt() || n.get("correctAnswer").asInt()<0 || n.get("correctAnswer").asInt()>=options.size())) throw ApiErrors.bad("correctAnswer: chỉ số từ 0");
            if(n.hasNonNull("critical") && !n.get("critical").isBoolean()) throw ApiErrors.bad("critical: phải là boolean");
            if(n.hasNonNull("imageRequired") && !n.get("imageRequired").isBoolean()) throw ApiErrors.bad("imageRequired: phải là boolean");
            text(n,"source",2000,publish); text(n,"explanation",10000,false);
            if(publish) {
                String label="Câu "+n.path("sourceExternalId").asText(n.path("externalId").asText());
                if(!n.hasNonNull("correctAnswer")) throw ApiErrors.bad(label+" chưa có đáp án đúng. Mở Sửa để chọn đáp án trước khi xuất bản.");
                if(!n.hasNonNull("critical")) throw ApiErrors.bad(label+" chưa được phân loại điểm liệt. Mở Sửa để xác nhận câu có hoặc không thuộc nhóm điểm liệt.");
                if(!n.path("reviewed").asBoolean(false)) throw ApiErrors.bad(label+" chưa được kiểm duyệt. Xác nhận đã kiểm tra đáp án và nguồn, hoặc dùng Duyệt và xuất bản các câu đã chọn.");
                if(n.path("imageRequired").asBoolean(false) && !n.hasNonNull("imageKey")) throw ApiErrors.bad(label+" còn thiếu ảnh bắt buộc. Ghép ảnh trước khi xuất bản.");
            }
        } else if(kind.equals("signs")) {
            alias(n,"externalId","sign_id"); sourceAlias(n,"code","sign_code"); sourceAlias(n,"code","ma_bien"); sourceAlias(n,"name","ten"); sourceAlias(n,"group","category"); sourceAlias(n,"group","nhom"); sourceAlias(n,"meaning","legal_description"); sourceAlias(n,"meaning","mo_ta");
            if(!n.hasNonNull("externalId")) n.put("externalId",n.path("code").asText());
            if(n.hasNonNull("unit_id")) {
                var source=units.findByUnitId(n.path("unit_id").asText()).flatMap(unit -> contents.findById(unit.documentId)).filter(document -> document.kind.equals("documents"));
                if(source.isPresent()) {
                    var document=read(source.get());
                    if(!n.hasNonNull("doc_id")) n.put("doc_id",source.get().externalId);
                    for(String field:List.of("so_hieu","ngay_hieu_luc","ngay_het_hieu_luc")) if(!n.hasNonNull(field)&&document.hasNonNull(field)) n.set(field,document.get(field));
                }
            }
            KagSchema.exactId(n,"externalId",250); sourceText(n,"code",100,true); sourceText(n,"name",500,true);
            sourceText(n,"group",200,true); sourceText(n,"meaning",20000,publish); sourceText(n,"visual_description",20000,false);
            if(publish||n.hasNonNull("doc_id")) KagSchema.exactId(n,"doc_id",250);
            if(publish||n.hasNonNull("unit_id")) KagSchema.exactId(n,"unit_id",500);
            sourceText(n,"qcvn",200,publish); sourceText(n,"so_hieu",200,publish);
            date(n,"ngay_hieu_luc",publish); date(n,"ngay_het_hieu_luc",false);
            for(String field:List.of("parent_code","description_scope","image_status","verification_status")) sourceText(n,field,100,false);
            if(n.hasNonNull("record_type")&&n.path("record_type").isTextual()&&n.path("record_type").asText().isBlank())n.putNull("record_type");
            if(n.hasNonNull("record_type")&&!Set.of("family","variant","standalone","unverified_code").contains(n.path("record_type").asText()))throw ApiErrors.bad("record_type không hợp lệ");
            for(String field:List.of("children_codes","note")) if(n.hasNonNull(field)) {
                if(!n.path(field).isArray())throw ApiErrors.bad(field+": cần mảng chuỗi");
                for(var item:n.path(field))if(!item.isTextual()||item.asText().isBlank())throw ApiErrors.bad(field+": cần mảng chuỗi không trống");
            }
            if(n.hasNonNull("image_required")&&!n.path("image_required").isBoolean())throw ApiErrors.bad("image_required: cần boolean hoặc null");
            if(publish && (!n.path("reviewed").asBoolean(false)||!n.hasNonNull("imageKey"))) throw ApiErrors.bad("Biển báo cần ảnh và reviewed=true trước khi xuất bản");
            if(publish) {
                signs.validateRelations(n);
                var doc=contents.findByKindAndExternalId("documents",n.path("doc_id").asText());
                var unit=units.findByUnitId(n.path("unit_id").asText());
                if(doc.isEmpty()||!doc.get().published||unit.isEmpty()||!unit.get().published||!unit.get().documentId.equals(doc.get().id)) throw ApiErrors.bad("Biển báo cần unit và văn bản nguồn tương ứng đã xuất bản");
            }
        } else {
            alias(n,"externalId","doc_id"); KagSchema.exactId(n,"externalId",250); sourceText(n,"title",1000,true);
            sourceText(n,"so_hieu",200,publish); text(n,"source",2000,publish);
            date(n,"ngay_hieu_luc",publish); date(n,"ngay_het_hieu_luc",false);
            if(publish && (!n.path("reviewed").asBoolean(false)||!n.hasNonNull("fileKey"))) throw ApiErrors.bad("Văn bản cần tệp nguồn và reviewed=true");
        }
        if(n.hasNonNull("ngay_hieu_luc")&&n.hasNonNull("ngay_het_hieu_luc") && LocalDate.parse(n.path("ngay_het_hieu_luc").asText()).isBefore(LocalDate.parse(n.path("ngay_hieu_luc").asText()))) throw ApiErrors.bad("Ngày hết hiệu lực trước ngày hiệu lực");
        return n;
    }
    public Map<String,Object> view(Content c,boolean admin) {
        var n=read(c);
        if(!admin&&c.kind.equals("questions")) n.retain(List.of("externalId","text","chapter","options","source","imageRequired","imageKey","imageMime"));
        return Map.of("id",c.id,"externalId",c.externalId,"version",c.version,"published",c.published,"data",n);
    }
    public static boolean effective(ObjectNode n) {
        LocalDate today=LocalDate.now();
        return (!n.hasNonNull("ngay_hieu_luc")||!LocalDate.parse(n.path("ngay_hieu_luc").asText()).isAfter(today))
            && (!n.hasNonNull("ngay_het_hieu_luc")||LocalDate.parse(n.path("ngay_het_hieu_luc").asText()).isAfter(today));
    }
    
    public List<Map<String,Object>> list(String kind,Integer chapter) {
        return list(kind,chapter,null);
    }
    public List<Map<String,Object>> list(String kind,Integer chapter,UUID set) {
        if(set!=null) {
            if(!kind.equals("questions"))throw ApiErrors.bad("Chỉ câu hỏi có bộ câu hỏi");
            return bank.questions(set).stream().filter(q->chapter==null||q.path("chapter").asInt()==chapter).map(q->{
                String id=q.path("questionId").asText();q.retain(List.of("externalId","text","chapter","chapterName","options","imageKey","imageMime"));q.put("questionSetId",set.toString());
                return Map.<String,Object>of("id",id,"externalId",q.path("externalId").asText(),"version",0,"published",true,"data",q);
            }).toList();
        }
        return contents.findByKindAndPublishedTrueOrderByExternalId(kind).stream()
            .filter(c -> isEffective(c) && (chapter==null||read(c).path("chapter").asInt()==chapter)).map(c -> view(c,false)).toList();
    }
    
    public List<Map<String,Object>> admin(String kind) {
        var names=kind.equals("questions")?bank.chapterNames():Map.<String,String>of();
        return contents.findByKindOrderByExternalId(kind).stream().map(c -> {
            var result=view(c,true);var n=(ObjectNode)result.get("data");
            if(kind.equals("questions"))n.put("chapterName",names.getOrDefault(n.path("questionSetId").asText()+":"+n.path("chapter").asInt(),"Chương "+n.path("chapter").asInt()));
            return result;
        }).toList();
    }
    
    public List<Map<String,Object>> preview(String kind,ImportRequest input) {
        kind(kind); var seen=new HashSet<String>(); var result=new ArrayList<Map<String,Object>>(); int line=0;
        for(var row:input.rows()) {
            line++;
            try {
                var n=validate(kind,scoped(kind,row,input.questionSetId()),false); String key=n.path("externalId").asText();
                if(!seen.add(key)) throw ApiErrors.bad("Trùng mã trong tệp");
                boolean exists=contents.findByKindAndExternalId(kind,key).isPresent();
                result.add(Map.of("row",line,"valid",true,"existing",exists,"data",n));
            } catch(ResponseStatusException e) { result.add(Map.of("row",line,"valid",false,"message",Objects.requireNonNull(e.getReason()))); }
        }
        return result;
    }
    @Transactional
    public Map<String,Integer> confirm(String kind,ImportRequest input) {
        kind(kind); var seen=new HashSet<String>(); int inserted=0,updated=0,skipped=0;
        for(var row:input.rows()) {
            var n=validate(kind,scoped(kind,row,input.questionSetId()),false); String key=n.path("externalId").asText();
            if(!seen.add(key)) throw ApiErrors.bad("Trùng mã trong tệp: "+key);
            var existing=contents.findByKindAndExternalId(kind,key);
            if(existing.isPresent()&&!input.updateExisting()) { skipped++; continue; }
            var c=existing.orElseGet(Content::new);
            // Imported media references are never trusted; retain only assets uploaded on this server.
            n.remove(List.of("imageKey","fileKey","imageMime","fileMime"));
            if(existing.isPresent()) {
                remember(c);
                var old=read(c);
                for(String field:List.of("imageKey","fileKey","imageMime","fileMime")) if(old.has(field)) n.set(field,old.get(field));
                updated++;
            } else inserted++;
            c.kind=kind; c.externalId=key; c.data=write(n); c.published=false; contents.save(c);sync(c);
        }
        contents.flush(); return Map.of("inserted",inserted,"updated",updated,"skipped",skipped);
    }
    @Transactional
    public Map<String,Object> edit(UUID id,ContentChangeRequest input) {
        var c=contents.findById(id).orElseThrow(ApiErrors::missing);
        if(c.version!=input.version()) throw new ResponseStatusException(HttpStatus.CONFLICT,"Bản ghi vừa thay đổi");
        var n=validate(c.kind,input.data(),false); var old=read(c);
        if(!c.kind.equals("questions")&&!c.externalId.equals(n.path("externalId").asText())) throw ApiErrors.bad("Không đổi ID nguồn; tạo bản nháp mới nếu nguồn khác");
        remember(c);
        n.remove(List.of("imageKey","fileKey","imageMime","fileMime"));
        for(String field:List.of("imageKey","fileKey","imageMime","fileMime")) if(old.has(field)) n.set(field,old.get(field));
        c.externalId=n.path("externalId").asText(); c.data=write(n); c.published=false;
        contents.saveAndFlush(c);sync(c); return view(c,true);
    }
    @Transactional
    public void batchPublication(BatchPublicationRequest input) {
        var seen=new HashSet<UUID>();
        for(var row:input.rows()) {
            if(!seen.add(row.id())) throw ApiErrors.bad("Trùng ID trong danh sách");
            var c=contents.findById(row.id()).filter(q -> q.kind.equals("questions")).orElseThrow(ApiErrors::missing);
            if(c.version!=row.version()) throw new ResponseStatusException(HttpStatus.CONFLICT,"Câu hỏi vừa thay đổi: "+c.externalId);
            var n=read(c); n.put("reviewed",input.reviewed()); if(input.published()) validate(c.kind,n,true);
            remember(c); c.data=write(n); c.published=input.published(); contents.save(c);sync(c);
        }
        contents.flush();
    }
    @Transactional
    public void deleteQuestion(UUID id,long version) {
        var c=contents.findById(id).filter(row -> row.kind.equals("questions")).orElseThrow(ApiErrors::missing);
        if(c.version!=version) throw new ResponseStatusException(HttpStatus.CONFLICT,"Câu hỏi vừa thay đổi. Tải lại trước khi xóa.");
        if(c.published) throw ApiErrors.bad("Hủy xuất bản câu hỏi trước khi xóa.");
        bank.deleteQuestion(id);
        history.deleteAll(history.findByContentIdOrderByChangedAtDesc(id));
        contents.delete(c); contents.flush();
    }
    @Transactional
    public Map<String,Object> publish(UUID id,PublicationRequest input) {
        var c=contents.findById(id).orElseThrow(ApiErrors::missing);
        if(c.version!=input.version()) throw new ResponseStatusException(HttpStatus.CONFLICT,"Bản ghi vừa thay đổi");
        var n=read(c);
        if(input.published()) {
            validate(c.kind,n,true);
            if(c.kind.equals("signs")) {n.put("image_status","verified");n.put("verification_status","verified");}
        }
        remember(c);
        c.data=write(n);c.published=input.published(); contents.saveAndFlush(c);sync(c); return view(c,true);
    }
    private JsonNode scoped(String kind,JsonNode row,UUID set) {
        if(set==null)return row;
        if(!kind.equals("questions")||!row.isObject())throw ApiErrors.bad("Chỉ câu hỏi được gán bộ câu hỏi");
        bank.set(set);var n=((ObjectNode)row).deepCopy();
        String source=n.path("sourceExternalId").asText(n.path("externalId").asText(n.path("id").asText(n.path("code").asText())));
        if(source.isBlank()||source.length()>200)throw ApiErrors.bad("Mã câu hỏi nguồn trống hoặc quá dài");
        n.put("sourceExternalId",source);n.put("externalId",set+"::"+source);n.remove(List.of("id","code"));n.put("questionSetId",set.toString());return n;
    }
}
