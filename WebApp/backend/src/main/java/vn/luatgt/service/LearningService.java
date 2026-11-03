package vn.luatgt.service;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.security.SecureRandom;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import vn.luatgt.dto.AnswerRequest;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.model.Exam;
import vn.luatgt.model.StudyAttempt;
import vn.luatgt.repository.ContentRepository;
import vn.luatgt.repository.ExamRepository;
import vn.luatgt.repository.StudyAttemptRepository;
import vn.luatgt.integration.ObjectStorage;

@Service
public class LearningService {
    private final ContentRepository contents; private final ExamRepository exams; private final StudyAttemptRepository studies; private final ContentService data; private final RateLimit rate;
    private final SecureRandom random=new SecureRandom();
    private final ObjectStorage storage;
    private final vn.luatgt.repository.LearningCatalogRepository bank;
    public LearningService(ContentRepository contents,ExamRepository exams,StudyAttemptRepository studies,ContentService data,RateLimit rate,ObjectStorage storage,vn.luatgt.repository.LearningCatalogRepository bank) {
        this.contents=contents; this.exams=exams; this.studies=studies; this.data=data; this.rate=rate;
        this.storage=storage;this.bank=bank;
    }
    public MediaService.Download studyMedia(UUID set,UUID question) {
        var q=bank.questions(set).stream().filter(n->n.path("questionId").asText().equals(question.toString())&&n.hasNonNull("imageKey")).findFirst().orElseThrow(ApiErrors::missing);
        return new MediaService.Download(storage.get(q.path("imageKey").asText()),q.path("imageMime").asText("image/png"));
    }
    @Transactional
    public MediaService.Download examMedia(UUID id,UUID questionId,JwtAuthenticationToken auth) {
        if(bank.exists(id)) {
            bank.owned(id,AuthService.user(auth));
            for(var q:bank.attemptQuestions(id))if(q.path("questionId").asText().equals(questionId.toString())&&q.hasNonNull("imageKey"))return new MediaService.Download(storage.get(q.path("imageKey").asText()),q.path("imageMime").asText("image/png"));
            throw ApiErrors.missing();
        }
        var e=exams.findById(id).filter(exam -> exam.ownerId.equals(AuthService.user(auth))).orElseThrow(ApiErrors::missing);
        for(var q:snapshot(e)) if(q.path("questionId").asText().equals(questionId.toString())&&q.hasNonNull("imageKey"))
            return new MediaService.Download(storage.get(q.path("imageKey").asText()),q.path("imageMime").asText("image/png"));
        throw ApiErrors.missing();
    }
    ArrayNode snapshot(Exam e) { try { return (ArrayNode)data.mapper().readTree(e.snapshot); } catch(Exception ex) { throw new IllegalStateException(ex); } }
    public ObjectNode answers(Exam e) { try { return (ObjectNode)data.mapper().readTree(e.answers); } catch(Exception ex) { throw new IllegalStateException(ex); } }
    @Transactional
    public Map<String,Object> study(UUID questionId,AnswerRequest choice,JwtAuthenticationToken auth) {
        rate.check("study:"+auth.getName(),120,60);
        var c=contents.findById(questionId).filter(q -> q.kind.equals("questions")&&q.published).orElseThrow(ApiErrors::missing);
        var q=data.read(c);
        UUID member=null,set=choice.questionSetId();
        if(set==null) {member=bank.publish(c,q);set=q.hasNonNull("questionSetId")?UUID.fromString(q.path("questionSetId").asText()):bank.legacySet();}
        final UUID selectedMember=member;
        var revision=bank.questions(set).stream().filter(row->selectedMember==null?row.path("questionId").asText().equals(questionId.toString()):row.path("set_question_id").asText().equals(selectedMember.toString())).findFirst().orElseThrow(ApiErrors::missing);
        if(choice.selected()>=revision.path("options").size())throw ApiErrors.bad("Đáp án không tồn tại");
        bank.study(AuthService.user(auth),revision,choice.selected());
        return Map.of("correct",choice.selected()==revision.path("correctAnswer").asInt(),"correctAnswer",revision.path("correctAnswer"),"explanation",revision.path("explanation").asText(""),"critical",revision.path("critical").asBoolean());
    }
    
    public List<Map<String,Object>> progress(JwtAuthenticationToken auth) {
        return progress(auth,null);
    }
    public List<Map<String,Object>> progress(JwtAuthenticationToken auth,UUID set) {
        var attempts=new ArrayList<>(studies.findByOwnerId(AuthService.user(auth))); var result=new ArrayList<Map<String,Object>>();
        if(set!=null) {var ids=bank.questions(set).stream().map(q->UUID.fromString(q.path("questionId").asText())).collect(java.util.stream.Collectors.toSet());attempts.removeIf(a->!ids.contains(a.questionId));}
        for(var row:bank.progress(AuthService.user(auth))) {if(set!=null&&!row.path("set_id").asText().equals(set.toString()))continue;var a=new StudyAttempt();a.questionId=UUID.fromString(row.path("question_id").asText());a.chapter=row.path("chapter").asInt();a.correct=row.path("correct").asBoolean();attempts.add(a);}
        for(int chapter=1;chapter<=6;chapter++) {
            final int ch=chapter; var selected=attempts.stream().filter(a -> a.chapter==ch).toList();
            result.add(Map.of("chapter",ch,"attempts",selected.size(),"correct",selected.stream().filter(a -> a.correct).count(),"practiced",selected.stream().map(a -> a.questionId).distinct().count()));
        }
        return result;
    }
    @Transactional
    public Map<String,Object> start(JwtAuthenticationToken auth) {return start(auth,null);}
    @Transactional
    public Map<String,Object> start(JwtAuthenticationToken auth,UUID ruleId) {
        rate.check("exam:"+auth.getName(),10,3600);
        var available=bank.rules(true);
        if(available.isEmpty()&&bank.rules(false).isEmpty()) {
            var legacy=contents.findByKindAndPublishedTrueOrderByExternalId("questions").stream().filter(c->!data.read(c).hasNonNull("questionSetId")).toList();
            if(!legacy.isEmpty()) {
                for(var c:legacy)bank.publish(c,data.read(c));
                var n=data.mapper().createObjectNode().put("setId",bank.legacySet().toString()).put("license","B").put("validFrom",LocalDate.now().toString()).put("totalQuestions",30).put("durationMinutes",20).put("minimumCorrect",27).put("criticalSlots",1).put("failOnCritical",true);
                n.set("quotas",data.mapper().valueToTree(new int[]{8,1,1,1,9,9}));bank.createRule(n);available=bank.rules(true);
            }
        }
        if(available.isEmpty())throw ApiErrors.bad("Chưa có quy tắc đề đang hiệu lực; cần cấu hình bộ và hạng thi");
        if(ruleId==null&&available.size()!=1)throw ApiErrors.bad("Cần chọn quy tắc đề thi");
        var rule=ruleId==null?available.getFirst():available.stream().filter(r->r.path("rule_id").asText().equals(ruleId.toString())).findFirst().orElseThrow(()->ApiErrors.bad("Quy tắc đề không còn hiệu lực"));
        var pool=new ArrayList<>(bank.questions(UUID.fromString(rule.path("set_id").asText())));Collections.shuffle(pool,random);
        var selected=new ArrayList<ObjectNode>();int critical=rule.path("critical_slots").asInt();
        selected.addAll(pool.stream().filter(q->q.path("critical").asBoolean()).limit(critical).toList());
        if(selected.size()!=critical)throw ApiErrors.bad("Bộ câu hỏi chưa đủ câu điểm liệt đã xuất bản");
        for(var quota:bank.quotas(UUID.fromString(rule.path("rule_id").asText()))) {
            int chapter=quota.path("chapter").asInt(),count=quota.path("question_quota").asInt();
            var chapterPool=pool.stream().filter(q->q.path("chapter").asInt()==chapter&&!q.path("critical").asBoolean()).limit(count).toList();
            if(chapterPool.size()!=count)throw ApiErrors.bad("Bộ đã xuất bản chưa đủ câu chương "+chapter);selected.addAll(chapterPool);
        }
        if(selected.size()!=rule.path("total_questions").asInt())throw ApiErrors.bad("Chỉ tiêu đề không khớp tổng số câu");
        Collections.shuffle(selected,random);UUID attempt=bank.createAttempt(AuthService.user(auth),rule,selected);return catalogView(attempt,auth,false);
    }
    private Exam owned(UUID id,JwtAuthenticationToken auth) { return exams.owned(id,AuthService.user(auth)).orElseThrow(ApiErrors::missing); }
    private void finish(Exam e) {
        if(e.submittedAt!=null) return;
        var answered=answers(e); int score=0; boolean critical=false;
        for(var q:snapshot(e)) {
            var selected=answered.get(q.path("questionId").asText());
            boolean correct=selected!=null&&selected.asInt()==q.path("correctAnswer").asInt();
            if(correct) score++; else if(q.path("critical").asBoolean()) critical=true;
        }
        e.score=score; e.criticalFailed=critical; e.passed=score>=27&&!critical;
        e.submittedAt=Instant.now(); exams.save(e);
    }
    private Map<String,Object> examView(Exam e) {
        var qs=snapshot(e);
        if(e.submittedAt==null) for(var q:qs) ((ObjectNode)q).retain(List.of("questionId","externalId","text","chapter","options","imageKey","imageMime"));
        var result=new LinkedHashMap<String,Object>(); result.put("id",e.id); result.put("license","B"); result.put("ruleset","B-2025-06");
        result.put("startedAt",e.startedAt); result.put("expiresAt",e.expiresAt); result.put("serverTime",Instant.now());
        result.put("questions",qs); result.put("answers",answers(e)); result.put("submittedAt",e.submittedAt);
        if(e.submittedAt!=null) { result.put("score",e.score); result.put("criticalFailed",e.criticalFailed); result.put("passed",e.passed); }
        return result;
    }
    @Transactional
    public Map<String,Object> exam(UUID id,JwtAuthenticationToken auth) {
        if(bank.exists(id))return catalogView(id,auth,false);
        var e=owned(id,auth); if(!Instant.now().isBefore(e.expiresAt)) finish(e); return examView(e);
    }
    @Transactional
    public Map<String,Object> answer(UUID id,UUID questionId,AnswerRequest choice,JwtAuthenticationToken auth) {
        if(bank.exists(id)) {
            var e=bank.owned(id,AuthService.user(auth));
            if(e.hasNonNull("submitted_at")||!Instant.now().isBefore(Instant.parse(e.path("expires_at").asText())))throw new ResponseStatusException(HttpStatus.CONFLICT,"Bài thi đã nộp hoặc hết giờ");
            var q=bank.attemptQuestions(id).stream().filter(n->n.path("questionId").asText().equals(questionId.toString())).findFirst().orElseThrow(ApiErrors::missing);
            if(choice.selected()>=q.path("options").size())throw ApiErrors.bad("Đáp án không tồn tại");
            bank.answer(q,choice.selected());return catalogView(id,auth,false);
        }
        var e=owned(id,auth);
        if(e.submittedAt!=null||!Instant.now().isBefore(e.expiresAt)) throw new ResponseStatusException(HttpStatus.CONFLICT,"Bài thi đã nộp hoặc hết giờ");
        var q=new ArrayList<JsonNode>(); snapshot(e).forEach(q::add);
        var question=q.stream().filter(n -> n.path("questionId").asText().equals(questionId.toString())).findFirst().orElseThrow(ApiErrors::missing);
        if(choice.selected()>=question.path("options").size()) throw ApiErrors.bad("Đáp án không tồn tại");
        var a=answers(e); a.put(questionId.toString(),choice.selected()); e.answers=data.write(a); exams.save(e); return examView(e);
    }
    @Transactional
    public Map<String,Object> submit(UUID id,JwtAuthenticationToken auth) { if(bank.exists(id))return catalogView(id,auth,true);var e=owned(id,auth); finish(e); return examView(e); }
    
    public List<Map<String,Object>> history(JwtAuthenticationToken auth) {
        var legacy=exams.findTop20ByOwnerIdOrderByStartedAtDesc(AuthService.user(auth)).stream().map(e -> {
            var result=new LinkedHashMap<String,Object>(); result.put("id",e.id); result.put("startedAt",e.startedAt);
            result.put("submittedAt",e.submittedAt); result.put("score",e.score); result.put("passed",e.passed);result.put("license","B");result.put("total",30);result.put("criticalFailed",e.criticalFailed); return (Map<String,Object>)result;
        }).toList();
        var result=new ArrayList<Map<String,Object>>(legacy);
        for(var row:bank.history(AuthService.user(auth))) {var item=new LinkedHashMap<String,Object>();for(String[] pair:new String[][]{{"id","id"},{"started_at","startedAt"},{"submitted_at","submittedAt"},{"score","score"},{"passed","passed"},{"critical_failed","criticalFailed"},{"class_code","license"},{"total_questions","total"}})item.put(pair[1],data.mapper().convertValue(row.get(pair[0]),Object.class));result.add(item);}
        result.sort(Comparator.comparing((Map<String,Object> item)->Instant.parse(item.get("startedAt").toString())).reversed());return result.stream().limit(20).toList();
    }
    private Map<String,Object> catalogView(UUID id,JwtAuthenticationToken auth,boolean submit) {
        var e=bank.owned(id,AuthService.user(auth));var rule=bank.rule(UUID.fromString(e.path("rule_id").asText()));var questions=bank.attemptQuestions(id);
        boolean finished=e.hasNonNull("submitted_at");
        if(!finished&&(submit||!Instant.now().isBefore(Instant.parse(e.path("expires_at").asText())))) {
            int score=0;boolean failed=false;
            for(var q:questions) {boolean correct=q.hasNonNull("selected")&&q.path("selected").asInt()==q.path("correctAnswer").asInt();if(correct)score++;else if(q.path("critical").asBoolean())failed=true;}
            bank.finish(id,score,failed,score>=rule.path("minimum_correct").asInt()&&(!rule.path("fail_on_critical").asBoolean()||!failed));e=bank.owned(id,AuthService.user(auth));finished=true;
        }
        var answers=data.mapper().createObjectNode();
        for(var q:questions) {
            if(q.hasNonNull("selected"))answers.set(q.path("questionId").asText(),q.get("selected"));
            q.retain(finished?List.of("questionId","externalId","text","chapter","options","imageKey","imageMime","correctAnswer","critical","explanation"):List.of("questionId","externalId","text","chapter","options","imageKey","imageMime"));
        }
        var result=new LinkedHashMap<String,Object>();result.put("id",id);result.put("license",rule.path("class_code").asText());result.put("ruleset",rule.path("rule_id").asText());result.put("minimumCorrect",rule.path("minimum_correct").asInt());result.put("durationMinutes",rule.path("duration_minutes").asInt());result.put("total",rule.path("total_questions").asInt());
        result.put("startedAt",e.path("started_at").asText());result.put("expiresAt",e.path("expires_at").asText());result.put("serverTime",Instant.now());result.put("submittedAt",e.hasNonNull("submitted_at")?e.path("submitted_at").asText():null);result.put("questions",questions);result.put("answers",answers);
        if(finished) {result.put("score",e.path("score").asInt());result.put("criticalFailed",e.path("critical_failed").asBoolean());result.put("passed",e.path("passed").asBoolean());}return result;
    }
}
