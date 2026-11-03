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
    @Transactional public void endRule(UUID id,ObjectNode n) {ContentService.date(n,"validTo",true);bank.endRule(id,LocalDate.parse(n.path("validTo").asText()));}
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
        try {UUID.fromString(n.path("setId").asText());}catch(IllegalArgumentException e){throw ApiErrors.bad("setId không hợp lệ");}
        ContentService.text(n,"license",12,true);if(!n.path("license").asText().matches("[A-Z][A-Z0-9]*"))throw ApiErrors.bad("Hạng GPLX không hợp lệ");
        ContentService.date(n,"validFrom",true);ContentService.date(n,"validTo",false);
        if(n.hasNonNull("validTo")&&!LocalDate.parse(n.path("validTo").asText()).isAfter(LocalDate.parse(n.path("validFrom").asText())))throw ApiErrors.bad("Ngày kết thúc phải sau ngày bắt đầu");
        for(String field:List.of("totalQuestions","durationMinutes","minimumCorrect","criticalSlots")) if(!n.path(field).isIntegralNumber()||!n.path(field).canConvertToInt())throw ApiErrors.bad(field+": cần số nguyên");
        int total=n.path("totalQuestions").asInt(),minimum=n.path("minimumCorrect").asInt(),critical=n.path("criticalSlots").asInt(),minutes=n.path("durationMinutes").asInt();
        if(total<1||total>200||minutes<1||minutes>240||minimum<1||minimum>total||critical<0||critical>total||!n.path("failOnCritical").isBoolean())throw ApiErrors.bad("Số câu, thời gian, ngưỡng đạt hoặc cấu hình điểm liệt không hợp lệ");
        if(!n.path("quotas").isArray()||n.path("quotas").size()!=6)throw ApiErrors.bad("quotas cần sáu chỉ tiêu câu thường theo chương; câu điểm liệt tính riêng");
        int sum=critical;for(var quota:n.path("quotas")) {if(!quota.isIntegralNumber()||!quota.canConvertToInt()||quota.asInt()<0||quota.asInt()>total)throw ApiErrors.bad("Chỉ tiêu chương không hợp lệ");sum+=quota.asInt();}
        if(sum!=total)throw ApiErrors.bad("Tổng chỉ tiêu câu thường và câu điểm liệt phải bằng tổng số câu");
        return bank.createRule(n);
    }
}
