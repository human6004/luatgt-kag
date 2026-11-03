package vn.luatgt.repository;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import java.nio.ByteBuffer;
import java.sql.*;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.model.Content;

@Repository
public class LearningCatalogRepository {
    private final JdbcTemplate db;
    private final ObjectMapper json;
    public LearningCatalogRepository(JdbcTemplate db,ObjectMapper json) { this.db=db; this.json=json; }
    public static byte[] binary(UUID id) { return ByteBuffer.allocate(16).putLong(id.getMostSignificantBits()).putLong(id.getLeastSignificantBits()).array(); }
    public static UUID uuid(byte[] value) { var b=ByteBuffer.wrap(value); return new UUID(b.getLong(),b.getLong()); }
    private ObjectNode row(ResultSet rs) throws SQLException {
        var n=json.createObjectNode(); var meta=rs.getMetaData();
        for(int i=1;i<=meta.getColumnCount();i++) {
            String key=meta.getColumnLabel(i).toLowerCase(Locale.ROOT); Object value=rs.getObject(i);
            if(value instanceof byte[] bytes) n.put(key,uuid(bytes).toString());
            else if(value instanceof Timestamp time) n.put(key,time.toInstant().toString());
            else if(value instanceof Boolean b) n.put(key,b);
            else if(value instanceof Number number) n.set(key,json.valueToTree(number));
            else if(value==null) n.putNull(key); else n.put(key,value.toString());
        }
        return n;
    }
    private List<ObjectNode> query(String sql,Object... args) { return db.query(sql,(rs,index)->row(rs),args); }
    private UUID id(ObjectNode row,String field) { return UUID.fromString(row.path(field).asText()); }
    private UUID catalog(String code,String title) {
        var found=query("SELECT release_id FROM bank_release WHERE release_code=? FOR UPDATE",code);
        if(!found.isEmpty()) return id(found.getFirst(),"release_id");
        UUID id=UUID.randomUUID(); db.update("INSERT INTO bank_release(release_id,release_code,title) VALUES (?,?,?)",binary(id),code,title); return id;
    }
    public List<ObjectNode> sets() {
        return query("SELECT s.set_id,s.set_code,s.set_name,b.release_code,b.title,b.issued_on,b.effective_from,b.effective_to,b.source_url FROM question_set s JOIN bank_release b ON b.release_id=s.release_id ORDER BY b.release_code,s.set_code");
    }
    public ObjectNode createSet(ObjectNode n) {
        UUID release=catalog(n.path("releaseCode").asText(),n.path("releaseTitle").asText());
        var metadata=query("SELECT * FROM bank_release WHERE release_id=?",binary(release)).getFirst();
        for(String[] pair:new String[][]{{"releaseTitle","title"},{"issuedOn","issued_on"},{"effectiveFrom","effective_from"},{"effectiveTo","effective_to"},{"sourceUrl","source_url"}}) {
            if(n.hasNonNull(pair[0])&&!n.path(pair[0]).asText().isBlank()&&metadata.hasNonNull(pair[1])&&!metadata.path(pair[1]).asText().equals(n.path(pair[0]).asText()))throw ApiErrors.bad("Đợt ban hành đã có thông tin khác: "+pair[0]);
        }
        var existing=query("SELECT set_id FROM question_set WHERE release_id=? AND set_code=?",binary(release),n.path("setCode").asText());
        if(!existing.isEmpty()) throw ApiErrors.bad("Bộ câu hỏi đã tồn tại trong đợt phát hành");
        UUID set=UUID.randomUUID(); db.update("INSERT INTO question_set(set_id,release_id,set_code,set_name) VALUES (?,?,?,?)",binary(set),binary(release),n.path("setCode").asText(),n.path("setName").asText());
        db.update("UPDATE bank_release SET issued_on=COALESCE(issued_on,?),effective_from=COALESCE(effective_from,?),effective_to=COALESCE(effective_to,?),source_url=COALESCE(source_url,?) WHERE release_id=?",
            n.path("issuedOn").isTextual()?n.path("issuedOn").asText():null,n.path("effectiveFrom").isTextual()?n.path("effectiveFrom").asText():null,n.path("effectiveTo").isTextual()?n.path("effectiveTo").asText():null,n.path("sourceUrl").asText("").isBlank()?null:n.path("sourceUrl").asText(),binary(release));
        return json.createObjectNode().put("id",set.toString());
    }
    public ObjectNode set(UUID set) { return query("SELECT s.*,b.release_code FROM question_set s JOIN bank_release b ON b.release_id=s.release_id WHERE s.set_id=? FOR UPDATE",binary(set)).stream().findFirst().orElseThrow(ApiErrors::missing); }
    public UUID legacySet() {
        UUID release=catalog("LEGACY","Dữ liệu hiện có; chưa xác minh đợt ban hành");
        var existing=query("SELECT set_id FROM question_set WHERE release_id=? AND set_code='LEGACY'",binary(release));
        if(!existing.isEmpty()) return id(existing.getFirst(),"set_id");
        UUID set=UUID.randomUUID(); db.update("INSERT INTO question_set VALUES (?,?,?,?)",binary(set),binary(release),"LEGACY","Ngân hàng hiện có"); return set;
    }
    public UUID publish(Content c,ObjectNode n) {
        UUID set=n.hasNonNull("questionSetId")?UUID.fromString(n.path("questionSetId").asText()):legacySet();
        var configured=set(set); UUID release=id(configured,"release_id");
        var previous=query("SELECT sq.*,qr.*,t.chapter FROM set_question sq JOIN question_revision qr ON qr.revision_id=sq.revision_id JOIN topic t ON t.topic_id=sq.topic_id WHERE sq.set_id=? AND qr.question_id=?",binary(set),binary(c.id));
        if(!previous.isEmpty()) {
            var old=previous.getFirst();enrich(old);
            if(old.path("text").equals(n.path("text"))&&old.path("options").equals(n.path("options"))&&old.path("correctAnswer").equals(n.path("correctAnswer"))&&old.path("explanation").asText("").equals(n.path("explanation").asText(""))&&old.path("source_text").asText().equals(n.path("source").asText())&&old.path("critical").asBoolean()==n.path("critical").asBoolean()&&old.path("chapter").asInt()==n.path("chapter").asInt()&&old.path("imageKey").asText().equals(n.path("imageKey").asText())) return id(old,"set_question_id");
        }
        if(!previous.isEmpty()&&db.queryForObject("SELECT COUNT(*) FROM attempt_question WHERE set_question_id=?",Long.class,binary(id(previous.getFirst(),"set_question_id")))+
            db.queryForObject("SELECT COUNT(*) FROM study_attempt WHERE set_question_id=?",Long.class,binary(id(previous.getFirst(),"set_question_id")))>0)
            throw ApiErrors.bad("Câu đã có lịch sử luyện/thi. Hãy xuất bản phiên bản sửa vào bộ mới để giữ nguyên lịch sử");
        if(db.queryForObject("SELECT COUNT(*) FROM question WHERE question_id=?",Long.class,binary(c.id))==0) db.update("INSERT INTO question VALUES (?)",binary(c.id));
        var revisions=query("SELECT revision_id FROM question_revision WHERE question_id=? AND revision_no=?",binary(c.id),c.version);
        UUID revision=revisions.isEmpty()?UUID.randomUUID():id(revisions.getFirst(),"revision_id");
        if(revisions.isEmpty()) {
            db.update("INSERT INTO question_revision VALUES (?,?,?,?,?,?,?,?)",binary(revision),binary(c.id),c.version,n.path("text").asText(),n.path("explanation").asText(""),"single",n.path("sourceExternalId").asText(c.externalId),n.path("source").asText());
            for(int i=0;i<n.path("options").size();i++) db.update("INSERT INTO answer_option(option_id,revision_id,option_position,option_text,is_correct) VALUES (?,?,?,?,?)",binary(UUID.randomUUID()),binary(revision),i,n.path("options").get(i).asText(),i==n.path("correctAnswer").asInt());
            if(n.hasNonNull("imageKey")) db.update("INSERT INTO question_asset VALUES (?,?,?,?,?,?)",binary(UUID.randomUUID()),binary(revision),0,n.path("imageKey").asText(),n.path("imageMime").asText("image/png"),"Ảnh câu hỏi");
        }
        int chapter=n.path("chapter").asInt();
        var topics=query("SELECT topic_id FROM topic WHERE release_id=? AND chapter=?",binary(release),chapter);
        UUID topic=topics.isEmpty()?UUID.randomUUID():id(topics.getFirst(),"topic_id");
        if(topics.isEmpty()) db.update("INSERT INTO topic VALUES (?,?,?,?,?)",binary(topic),binary(release),"CH"+chapter,"Chương "+chapter,chapter);
        int number=n.path("number").asInt(0);
        if(number<1) number=previous.isEmpty()?db.queryForObject("SELECT COALESCE(MAX(source_no),0)+1 FROM set_question WHERE set_id=?",Integer.class,binary(set)):previous.getFirst().path("source_no").asInt();
        UUID member=previous.isEmpty()?UUID.randomUUID():id(previous.getFirst(),"set_question_id");
        if(previous.isEmpty()) db.update("INSERT INTO set_question VALUES (?,?,?,?,?,?,?)",binary(member),binary(set),binary(revision),binary(topic),binary(release),number,n.path("critical").asBoolean());
        else db.update("UPDATE set_question SET revision_id=?,topic_id=?,source_no=?,is_critical=? WHERE set_question_id=?",binary(revision),binary(topic),number,n.path("critical").asBoolean(),binary(member));
        return member;
    }
    public List<ObjectNode> questions(UUID set) {
        var rows=query("SELECT sq.set_question_id,sq.set_id,sq.revision_id,sq.is_critical,t.chapter,qr.question_id,qr.question_text,qr.explanation,qr.external_id,qr.source_text FROM set_question sq JOIN question_revision qr ON qr.revision_id=sq.revision_id JOIN topic t ON t.topic_id=sq.topic_id JOIN content c ON c.id=qr.question_id WHERE sq.set_id=? AND c.published=TRUE ORDER BY sq.source_no",binary(set));
        for(var q:rows) enrich(q); return rows;
    }
    private void enrich(ObjectNode q) {
        var options=query("SELECT option_id,option_position,option_text,is_correct FROM answer_option WHERE revision_id=? ORDER BY option_position",binary(id(q,"revision_id")));
        var labels=q.putArray("options"); var ids=q.putArray("optionIds");
        for(var option:options) { labels.add(option.path("option_text").asText()); ids.add(option.path("option_id").asText()); if(option.path("is_correct").asBoolean()) q.put("correctAnswer",option.path("option_position").asInt()); }
        q.put("questionId",q.path("question_id").asText()); q.put("externalId",q.path("external_id").asText()); q.put("text",q.path("question_text").asText()); q.put("critical",q.path("is_critical").asBoolean());
        var assets=query("SELECT media_url,mime_type FROM question_asset WHERE revision_id=? ORDER BY display_order",binary(id(q,"revision_id")));
        if(!assets.isEmpty()) {q.put("imageKey",assets.getFirst().path("media_url").asText());q.put("imageMime",assets.getFirst().path("mime_type").asText());}
    }
    public List<ObjectNode> rules(boolean active) {
        String sql="SELECT r.*,s.set_name,b.release_code,l.class_code,l.class_name FROM exam_rule r JOIN question_set s ON s.set_id=r.set_id JOIN bank_release b ON b.release_id=s.release_id JOIN license_class l ON l.class_id=r.class_id";
        if(!active)return query(sql+" ORDER BY l.class_code,r.valid_from DESC");
        var today=LocalDate.now(ZoneId.of("Asia/Ho_Chi_Minh")).toString();
        return query(sql+" WHERE r.valid_from<=? AND (r.valid_to IS NULL OR r.valid_to>?) AND (b.effective_from IS NULL OR b.effective_from<=?) AND (b.effective_to IS NULL OR b.effective_to>?) ORDER BY l.class_code,r.valid_from DESC",today,today,today,today);
    }
    public ObjectNode rule(UUID rule) { return rules(false).stream().filter(n->n.path("rule_id").asText().equals(rule.toString())).findFirst().orElseThrow(ApiErrors::missing); }
    public void endRule(UUID rule,LocalDate until) {
        var r=rule(rule);set(id(r,"set_id"));
        if(!until.isAfter(LocalDate.now(ZoneId.of("Asia/Ho_Chi_Minh")))||!until.isAfter(LocalDate.parse(r.path("valid_from").asText()))||r.hasNonNull("valid_to")&&until.isAfter(LocalDate.parse(r.path("valid_to").asText())))throw ApiErrors.bad("Chỉ được kết thúc quy tắc vào ngày tương lai, sau ngày bắt đầu; không gia hạn quy tắc cũ");
        db.update("UPDATE exam_rule SET valid_to=? WHERE rule_id=?",until.toString(),binary(rule));
    }
    public List<ObjectNode> quotas(UUID rule) { return query("SELECT t.chapter,rt.question_quota FROM exam_rule_topic rt JOIN topic t ON t.topic_id=rt.topic_id WHERE rule_id=? ORDER BY t.chapter",binary(rule)); }
    public ObjectNode createRule(ObjectNode n) {
        UUID set=UUID.fromString(n.path("setId").asText()); var s=set(set); UUID release=id(s,"release_id");
        String code=n.path("license").asText();
        var classes=query("SELECT class_id FROM license_class WHERE class_code=? FOR UPDATE",code); UUID license=classes.isEmpty()?UUID.randomUUID():id(classes.getFirst(),"class_id");
        if(classes.isEmpty()) db.update("INSERT INTO license_class VALUES (?,?,?)",binary(license),code,code);
        String until=n.hasNonNull("validTo")?n.path("validTo").asText():null;
        if(db.queryForObject("SELECT COUNT(*) FROM exam_rule WHERE class_id=? AND set_id=? AND (valid_to IS NULL OR valid_to>?) AND (? IS NULL OR valid_from<?)",Long.class,binary(license),binary(set),n.path("validFrom").asText(),until,until)>0) throw ApiErrors.bad("Khoảng hiệu lực quy tắc bị chồng trong cùng bộ và hạng");
        UUID rule=UUID.randomUUID();db.update("INSERT INTO exam_rule VALUES (?,?,?,?,?,?,?,?,?,?)",binary(rule),binary(set),binary(license),n.path("validFrom").asText(),until,n.path("totalQuestions").asInt(),n.path("durationMinutes").asInt(),n.path("minimumCorrect").asInt(),n.path("criticalSlots").asInt(),n.path("failOnCritical").asBoolean());
        for(int ch=1;ch<=6;ch++) {
            var topics=query("SELECT topic_id FROM topic WHERE release_id=? AND chapter=?",binary(release),ch); UUID topic=topics.isEmpty()?UUID.randomUUID():id(topics.getFirst(),"topic_id");
            if(topics.isEmpty()) db.update("INSERT INTO topic VALUES (?,?,?,?,?)",binary(topic),binary(release),"CH"+ch,"Chương "+ch,ch);
            db.update("INSERT INTO exam_rule_topic VALUES (?,?,?)",binary(rule),binary(topic),n.path("quotas").get(ch-1).asInt());
        }
        return rule(rule);
    }
    public UUID createAttempt(UUID owner,ObjectNode rule,List<ObjectNode> questions) {
        UUID attempt=UUID.randomUUID();Instant now=Instant.now();byte[] set=binary(id(rule,"set_id"));
        db.update("INSERT INTO exam_attempt(attempt_id,user_id,rule_id,set_id,started_at,expires_at) VALUES (?,?,?,?,?,?)",binary(attempt),binary(owner),binary(id(rule,"rule_id")),set,Timestamp.from(now),Timestamp.from(now.plusSeconds(rule.path("duration_minutes").asLong()*60)));
        for(int i=0;i<questions.size();i++) {var q=questions.get(i);db.update("INSERT INTO attempt_question VALUES (?,?,?,?,?,?)",binary(UUID.randomUUID()),binary(attempt),binary(id(q,"set_question_id")),set,binary(id(q,"revision_id")),i);}
        return attempt;
    }
    public boolean exists(UUID attempt) { return db.queryForObject("SELECT COUNT(*) FROM exam_attempt WHERE attempt_id=?",Long.class,binary(attempt))>0; }
    public ObjectNode owned(UUID attempt,UUID owner) { return query("SELECT * FROM exam_attempt WHERE attempt_id=? AND user_id=? FOR UPDATE",binary(attempt),binary(owner)).stream().findFirst().orElseThrow(ApiErrors::missing); }
    public List<ObjectNode> attemptQuestions(UUID attempt) {
        var rows=query("SELECT aq.attempt_question_id,aq.revision_id,sq.is_critical,t.chapter,qr.question_id,qr.question_text,qr.explanation,qr.external_id,qr.source_text,o.option_position AS selected FROM attempt_question aq JOIN set_question sq ON sq.set_question_id=aq.set_question_id JOIN topic t ON t.topic_id=sq.topic_id JOIN question_revision qr ON qr.revision_id=aq.revision_id LEFT JOIN attempt_answer a ON a.attempt_question_id=aq.attempt_question_id LEFT JOIN answer_option o ON o.option_id=a.option_id WHERE aq.attempt_id=? ORDER BY aq.display_position",binary(attempt));
        for(var q:rows) enrich(q);return rows;
    }
    public void answer(ObjectNode q,int selected) {
        byte[] attemptQuestion=binary(id(q,"attempt_question_id")),option=binary(UUID.fromString(q.path("optionIds").get(selected).asText())),revision=binary(id(q,"revision_id"));
        if(db.update("UPDATE attempt_answer SET option_id=? WHERE attempt_question_id=?",option,attemptQuestion)==0) db.update("INSERT INTO attempt_answer VALUES (?,?,?)",attemptQuestion,option,revision);
    }
    public void finish(UUID attempt,int score,boolean critical,boolean passed) { db.update("UPDATE exam_attempt SET submitted_at=?,score=?,critical_failed=?,passed=? WHERE attempt_id=? AND submitted_at IS NULL",Timestamp.from(Instant.now()),score,critical,passed,binary(attempt)); }
    public List<ObjectNode> history(UUID owner) {return query("SELECT a.attempt_id AS id,a.started_at,a.submitted_at,a.score,a.passed,a.critical_failed,r.total_questions,l.class_code FROM exam_attempt a JOIN exam_rule r ON r.rule_id=a.rule_id JOIN license_class l ON l.class_id=r.class_id WHERE a.user_id=? ORDER BY a.started_at DESC LIMIT 20",binary(owner));}
    public ObjectNode examSummary() {return query("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN passed=TRUE THEN 1 ELSE 0 END),0) AS passed FROM exam_attempt").getFirst();}
    public void study(UUID owner,ObjectNode q,int selected) {db.update("INSERT INTO study_attempt VALUES (?,?,?,?,?,?,?)",binary(UUID.randomUUID()),binary(owner),binary(id(q,"set_question_id")),binary(UUID.fromString(q.path("optionIds").get(selected).asText())),binary(id(q,"revision_id")),selected==q.path("correctAnswer").asInt(),Timestamp.from(Instant.now()));}
    public List<ObjectNode> progress(UUID owner) {return query("SELECT t.chapter,s.correct,qr.question_id,sq.set_id FROM study_attempt s JOIN set_question sq ON sq.set_question_id=s.set_question_id JOIN topic t ON t.topic_id=sq.topic_id JOIN question_revision qr ON qr.revision_id=s.revision_id WHERE s.user_id=?",binary(owner));}
}
