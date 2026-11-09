package vn.luatgt.service;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.LocalDate;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.repository.LearningCatalogRepository;

@Service
public class QuestionBankService {
    private final LearningCatalogRepository bank;
    private final com.fasterxml.jackson.databind.ObjectMapper json;
    public QuestionBankService(LearningCatalogRepository bank,com.fasterxml.jackson.databind.ObjectMapper json) {this.bank=bank;this.json=json;}
    public List<ObjectNode> sets() {return bank.sets();}
    public List<ObjectNode> chapters(UUID set) {return bank.chapters(set);}
    @Transactional public void saveChapter(UUID set,UUID topic,ObjectNode n) {
        if(!n.path("chapter").isIntegralNumber()||!n.path("chapter").canConvertToInt()||n.path("chapter").asInt()<1||n.path("chapter").asInt()>32767)throw ApiErrors.bad("Số chương phải là số nguyên từ 1 đến 32767");
        ContentService.text(n,"name",500,true);
        bank.saveChapter(set,topic,n.path("chapter").asInt(),n.path("name").asText());
    }
    @Transactional public void deleteChapter(UUID set,UUID topic) {bank.deleteChapter(set,topic);}
    @Transactional public void endRule(UUID id,ObjectNode n) {ContentService.date(n,"validTo",true);bank.endRule(id,LocalDate.parse(n.path("validTo").asText()));}
    @Transactional public void updateSet(UUID id,ObjectNode n) {
        for(String field:List.of("releaseCode","setCode")) {
            ContentService.text(n,field,field.equals("releaseCode")?40:30,true);
            if(!n.path(field).asText().matches("[A-Za-z0-9._-]+"))throw ApiErrors.bad(field+": chỉ dùng chữ, số, dấu chấm, gạch ngang hoặc gạch dưới");
        }
        ContentService.text(n,"setName",500,true);
        bank.updateSet(id,n);
    }
    @Transactional public void deleteSet(UUID id) {bank.deleteSet(id);}
    public List<ObjectNode> rules(boolean active) {
        var rules=bank.rules(active);
        for(var r:rules) r.set("quotas",json.valueToTree(bank.quotas(UUID.fromString(r.path("rule_id").asText()))));
        return rules;
    }
    @Transactional public ObjectNode createSet(ObjectNode n) {
        for(String field:List.of("releaseCode","setCode")) {
            ContentService.text(n,field,field.equals("releaseCode")?40:30,true);
            if(!n.path(field).asText().matches("[A-Za-z0-9._-]+"))throw ApiErrors.bad(field+": chỉ dùng chữ, số, dấu chấm, gạch ngang hoặc gạch dưới");
        }
        ContentService.text(n,"releaseTitle",500,true);ContentService.text(n,"setName",500,true);ContentService.text(n,"sourceUrl",2000,false);
        for(String field:List.of("issuedOn","effectiveFrom","effectiveTo"))ContentService.date(n,field,false);
        if(n.hasNonNull("effectiveTo")&&(!n.hasNonNull("effectiveFrom")||!LocalDate.parse(n.path("effectiveTo").asText()).isAfter(LocalDate.parse(n.path("effectiveFrom").asText()))))throw ApiErrors.bad("Ngày hết hiệu lực cần sau ngày hiệu lực");
        return bank.createSet(n);
    }
    @Transactional public ObjectNode createRule(ObjectNode n) {
        validateRule(n);
        return bank.createRule(n);
    }
    @Transactional public ObjectNode updateRule(UUID id,ObjectNode n) {
        var current=bank.rule(id);
        n.put("setId",current.path("set_id").asText());
        n.put("license",current.path("class_code").asText());
        validateRule(n);
        return bank.updateRule(id,n);
    }
    @Transactional public void deleteRule(UUID id) {bank.deleteRule(id);}
    private void validateRule(ObjectNode n) {
        try {UUID.fromString(n.path("setId").asText());}catch(IllegalArgumentException e){throw ApiErrors.bad("setId không hợp lệ");}
        ContentService.text(n,"license",12,true);if(!n.path("license").asText().matches("[A-Z][A-Z0-9]*"))throw ApiErrors.bad("Hạng GPLX không hợp lệ");
        ContentService.date(n,"validFrom",true);ContentService.date(n,"validTo",false);
        if(n.hasNonNull("validTo")&&!LocalDate.parse(n.path("validTo").asText()).isAfter(LocalDate.parse(n.path("validFrom").asText())))throw ApiErrors.bad("Ngày kết thúc phải sau ngày bắt đầu");
        for(String field:List.of("totalQuestions","durationMinutes","minimumCorrect","criticalSlots")) if(!n.path(field).isIntegralNumber()||!n.path(field).canConvertToInt())throw ApiErrors.bad(field+": cần số nguyên");
        int total=n.path("totalQuestions").asInt(),minimum=n.path("minimumCorrect").asInt(),critical=n.path("criticalSlots").asInt(),minutes=n.path("durationMinutes").asInt();
        if(total<1||total>200||minutes<1||minutes>240||minimum<1||minimum>total||critical<0||critical>total||!n.path("failOnCritical").isBoolean())throw ApiErrors.bad("Số câu, thời gian, ngưỡng đạt hoặc cấu hình điểm liệt không hợp lệ");
        if(!n.path("quotas").isArray()||n.path("quotas").size()>32767)throw ApiErrors.bad("Danh sách phân bổ chương không hợp lệ");
        var chapters=new HashSet<Integer>(); int sum=critical,index=0;
        for(var quota:n.path("quotas")) {
            index++;var count=quota.isObject()?quota.path("question_quota"):quota;
            var chapter=quota.isObject()?quota.path("chapter"):json.valueToTree(index);
            if(!chapter.isIntegralNumber()||!chapter.canConvertToInt()||chapter.asInt()<1||chapter.asInt()>32767||!chapters.add(chapter.asInt()))throw ApiErrors.bad("Số chương phải là số nguyên dương và không được trùng");
            if(!count.isIntegralNumber()||!count.canConvertToInt()||count.asInt()<0||count.asInt()>total)throw ApiErrors.bad("Chỉ tiêu chương không hợp lệ");sum+=count.asInt();
        }
        if(sum!=total)throw ApiErrors.bad("Tổng chỉ tiêu câu thường và câu điểm liệt phải bằng tổng số câu");
    }
}
