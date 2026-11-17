package vn.luatgt;
import vn.luatgt.model.*;
import vn.luatgt.repository.*;
import vn.luatgt.service.RateLimit;
import vn.luatgt.integration.*;
import com.fasterxml.jackson.databind.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.*;
import org.springframework.http.MediaType;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest @AutoConfigureMockMvc
class OperationsTest {
    @Autowired MockMvc mvc; @Autowired ObjectMapper json; @Autowired ContentRepository contents; @Autowired ChatRepository chats;
    @Autowired ContentHistoryRepository history;
    @Autowired StudyAttemptRepository attempts;
    @Autowired LegalUnitRepository legalUnits;
    @Autowired vn.luatgt.service.QuestionBankService questionBank;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @MockitoBean RateLimit rate; @MockitoBean KagClient kag; @MockitoBean ObjectStorage storage;
    String admin,user; UUID userId;
    JsonNode body(MvcResult result) throws Exception { return json.readTree(result.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8)); }
    @BeforeEach void auth() throws Exception {
        admin=body(mvc.perform(post("/api/auth/login").contentType(MediaType.APPLICATION_JSON).content("{\"email\":\"admin@test.vn\",\"password\":\"TEST-only-admin-password\"}")).andReturn()).path("accessToken").asText();
        var result=body(mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("email",UUID.randomUUID()+"@test.vn","name","Test","password","TEST-user-password")))).andReturn());
        user=result.path("accessToken").asText(); userId=UUID.fromString(result.path("user").path("id").asText());
    }
    Content doc() throws Exception {
        var c=new Content(); c.kind="documents"; c.externalId="TEST-"+UUID.randomUUID(); c.published=true;
        c.data=json.writeValueAsString(Map.of("externalId",c.externalId,"title","Văn bản kiểm tra","so_hieu","TEST","source","test-only","reviewed",true,"fileKey","test-pdf","fileMime","application/pdf","ngay_hieu_luc","2025-01-01")); return contents.save(c);
    }
    @Test void mysqlStoragePreservesUuidUnicodeLargeTextUtcAndForeignKeys() throws Exception {
        var c=new Content(); c.kind="documents"; c.externalId="Storage-"+UUID.randomUUID();
        c.data="Luật giao thông 🚦 " + "x".repeat(70000); c=contents.saveAndFlush(c);
        var stored=contents.findById(c.id).orElseThrow();
        assertEquals(c.id,stored.id); assertEquals(c.data,stored.data);
        var variant=new Content(); variant.kind=c.kind; variant.externalId=c.externalId.toLowerCase(Locale.ROOT); variant.data="{}";
        contents.saveAndFlush(variant);
        assertEquals(c.id,contents.findByKindAndExternalId(c.kind,c.externalId).orElseThrow().id);
        var chat=new ChatMessage(); chat.ownerId=userId; chat.question="Kiểm tra UTC"; chat.state="UNAVAILABLE";
        chat.createdAt=java.time.Instant.parse("2026-10-03T01:02:03.123456Z"); chat=chats.saveAndFlush(chat);
        assertEquals(chat.createdAt,chats.findById(chat.id).orElseThrow().createdAt);
        var invalid=new StudyAttempt(); invalid.ownerId=UUID.randomUUID(); invalid.questionId=c.id; invalid.chapter=1;
        assertThrows(org.springframework.dao.DataIntegrityViolationException.class,() -> attempts.saveAndFlush(invalid));
        mvc.perform(get("/api/admin/infrastructure").header("Authorization","Bearer "+admin))
            .andExpect(status().isOk()).andExpect(jsonPath("$.MySQL").value("UP"));
    }
    @Test void replacementInvalidatesOldLawAndPenaltiesAndRejectsCycles() throws Exception {
        var old=doc(); var next=doc();
        var penalty=body(mvc.perform(post("/api/admin/penalties").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("documentId",old.id,"published",true,"version",0,"data",Map.of("behavior","Hành vi thử","vehicle","Ô tô","minFine",100,"maxFine",200,"points",2,"unit_id","TEST::1","reviewed",true))))).andExpect(status().isOk()).andReturn());
        var rules=body(mvc.perform(get("/api/penalties").header("Authorization","Bearer "+user)).andReturn()); assertTrue(rules.toString().contains(penalty.path("id").asText()));
        var relation=Map.of("predecessor",old.id,"successor",next.id,"type","REPLACES","effectiveDate","2025-01-01","note","Thay thế thử");
        mvc.perform(post("/api/admin/law-relations").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(relation))).andExpect(status().isOk());
        rules=body(mvc.perform(get("/api/penalties").header("Authorization","Bearer "+user)).andReturn()); assertFalse(rules.toString().contains(penalty.path("id").asText()));
        var docs=body(mvc.perform(get("/api/documents").header("Authorization","Bearer "+user)).andReturn()); assertFalse(docs.toString().contains(old.id.toString())); assertTrue(docs.toString().contains(next.id.toString()));
        mvc.perform(post("/api/admin/law-relations").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("predecessor",next.id,"successor",old.id,"type","AMENDS","effectiveDate","2025-01-01","note","Vòng lặp")))).andExpect(status().isBadRequest());
    }
    @Test void feedbackIsOwnedAndResolutionsAreReported() throws Exception {
        var c=new ChatMessage(); c.ownerId=userId; c.question="Câu hỏi thử"; c.state="UNAVAILABLE"; c=chats.save(c);
        mvc.perform(post("/api/chat/"+c.id+"/feedback").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"feedback\":\"NO_BASIS\",\"note\":\"Thiếu căn cứ\"}")).andExpect(status().isOk());
        mvc.perform(post("/api/chat/"+c.id+"/feedback").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"feedback\":\"WRONG\"}")).andExpect(status().isNotFound());
        var pending=body(mvc.perform(get("/api/admin/chatlogs?pending=true").header("Authorization","Bearer "+admin)).andReturn()); assertTrue(pending.toString().contains(c.id.toString()));
        mvc.perform(post("/api/admin/chatlogs/"+c.id+"/resolve").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"note\":\"Chờ bổ sung KAG\"}")).andExpect(status().isOk());
        pending=body(mvc.perform(get("/api/admin/chatlogs?pending=true").header("Authorization","Bearer "+admin)).andReturn()); assertFalse(pending.toString().contains(c.id.toString()));
        mvc.perform(get("/api/admin/reports").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(jsonPath("$.pendingChats").isNumber());
    }
    @Test void conversationRenameAndDeleteAreOwnedAndPreserveReports() throws Exception {
        var root=new ChatMessage();root.ownerId=userId;root.question="Original question";root.state="UNAVAILABLE";root=chats.saveAndFlush(root);
        var turn=new ChatMessage();turn.ownerId=userId;turn.conversationId=root.id;turn.question="Follow-up";turn.state="ANSWERED";turn.feedback="WRONG";turn=chats.saveAndFlush(turn);
        String path="/api/chat/"+root.id;
        mvc.perform(patch(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Forbidden\"}")).andExpect(status().isNotFound());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin)).andExpect(status().isNotFound());
        mvc.perform(patch(path).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"  Biển báo  \"}")).andExpect(status().isNoContent());
        var saved=chats.findById(root.id).orElseThrow();
        assertEquals("Biển báo",saved.conversationTitle);assertEquals("Original question",saved.question);
        turn.state="PROCESSING";turn=chats.saveAndFlush(turn);
        mvc.perform(delete(path).header("Authorization","Bearer "+user)).andExpect(status().isConflict());
        turn.state="ANSWERED";chats.saveAndFlush(turn);
        mvc.perform(delete(path).header("Authorization","Bearer "+user)).andExpect(status().isNoContent());
        mvc.perform(delete(path).header("Authorization","Bearer "+user)).andExpect(status().isNoContent());
        var rows=body(mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertFalse(rows.toString().contains(root.id.toString()));assertFalse(rows.toString().contains(turn.id.toString()));
        assertTrue(chats.findById(turn.id).isPresent());
        assertTrue(chats.reported(false,org.springframework.data.domain.PageRequest.of(0,100)).stream().anyMatch(c->c.conversationId!=null&&c.conversationId.equals(saved.id)));
        var followup=new ChatMessage();followup.ownerId=userId;followup.conversationId=root.id;followup.question="Deleted conversation";followup.state="PROCESSING";
        assertThrows(org.springframework.web.server.ResponseStatusException.class,()->chats.append(followup));
        mvc.perform(patch(path).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Hidden\"}")).andExpect(status().isNotFound());
    }
    @Test void conversationHistoryLoadsOlderPagesWithoutSplittingTurnsOrSkippingAfterDeletion() throws Exception {
        var roots=new ArrayList<ChatMessage>();
        for(int i=0;i<53;i++) {
            var root=new ChatMessage();root.ownerId=userId;root.question="Page "+i;root.state="UNAVAILABLE";
            root.createdAt=java.time.Instant.parse("2026-01-01T00:00:00Z");roots.add(root);
        }
        chats.saveAllAndFlush(roots);
        var first=mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn();
        var rows=body(first);assertEquals(50,rows.size());
        var cursor=first.getResponse().getHeader("X-Next-Cursor");assertNotNull(cursor);assertFalse(cursor.isBlank());
        UUID last=UUID.fromString(rows.get(49).path("id").asText());
        var turn=new ChatMessage();turn.ownerId=userId;turn.conversationId=last;turn.question="New turn";turn.state="UNAVAILABLE";chats.saveAndFlush(turn);
        mvc.perform(delete("/api/chat/"+rows.get(0).path("id").asText()).header("Authorization","Bearer "+user)).andExpect(status().isNoContent());
        var second=mvc.perform(get("/api/chat").param("before",cursor).header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn();
        var older=body(second);assertEquals(3,older.size());
        assertEquals("",second.getResponse().getHeader("X-Next-Cursor"));
        for(var row:older) assertFalse(rows.toString().contains(row.path("id").asText()));
        String oldId=older.get(older.size()-1).path("id").asText();
        var selected=body(mvc.perform(get("/api/chat").param("selected",oldId).header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertEquals(52,selected.size());assertTrue(selected.toString().contains(oldId));
        mvc.perform(get("/api/chat").param("selected",oldId).header("Authorization","Bearer "+admin)).andExpect(status().isNotFound());
        var refreshed=body(mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        assertEquals(51,refreshed.size());assertTrue(refreshed.toString().contains(turn.id.toString()));
        var other=body(mvc.perform(get("/api/chat").param("before",cursor).header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andReturn());
        assertEquals(0,other.size());
        mvc.perform(get("/api/chat").param("before","invalid").header("Authorization","Bearer "+user)).andExpect(status().isBadRequest());
    }
    @Test void moderationOnlyExposesExplicitProblemReportsAndPreservesPrivateHistory() throws Exception {
        long before=body(mvc.perform(get("/api/admin/reports").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andReturn()).path("chatMessages").asLong();
        var privateChats=new ArrayList<ChatMessage>();
        for(String state:List.of("ANSWERED","KAG_ABSTAINED","UNAVAILABLE","PROCESSING","HELPFUL")) {
            var c=new ChatMessage();c.ownerId=userId;c.question="Private question "+UUID.randomUUID();c.answer="Private answer";c.state=state.equals("HELPFUL")?"ANSWERED":state;c.feedback=state.equals("HELPFUL")?"HELPFUL":null;privateChats.add(chats.saveAndFlush(c));
        }
        var reports=new ArrayList<ChatMessage>();
        for(String feedback:List.of("WRONG","NO_BASIS","OUTDATED")) {
            var c=new ChatMessage();c.ownerId=userId;c.question="Reported question "+feedback;c.state="ANSWERED";c.feedback=feedback;reports.add(chats.saveAndFlush(c));
        }
        var resolved=new ChatMessage();resolved.ownerId=userId;resolved.question="Resolved report";resolved.state="ANSWERED";resolved.feedback="OUTDATED";resolved.resolved=true;resolved=chats.saveAndFlush(resolved);
        for(String query:List.of("","?pending=false","?pending=true")) {
            var visible=body(mvc.perform(get("/api/admin/chatlogs"+query).header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andReturn());
            for(var c:privateChats)assertFalse(visible.toString().contains(c.id.toString()));
            for(var c:reports)assertTrue(visible.toString().contains(c.id.toString()));
            assertEquals(!query.equals("?pending=true"),visible.toString().contains(resolved.id.toString()));
            for(var row:visible)assertTrue(Set.of("WRONG","NO_BASIS","OUTDATED").contains(row.path("feedback").asText()));
        }
        mvc.perform(get("/api/admin/reports").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andExpect(jsonPath("$.chatMessages").value(before+4));
        for(var c:privateChats) {
            mvc.perform(post("/api/admin/chatlogs/"+c.id+"/resolve").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"note\":\"Must not access private chat\"}")).andExpect(status().isNotFound());
            assertFalse(chats.findById(c.id).orElseThrow().resolved);
        }
        var own=body(mvc.perform(get("/api/chat").header("Authorization","Bearer "+user)).andExpect(status().isOk()).andReturn());
        for(var c:privateChats)assertTrue(own.toString().contains(c.id.toString()));
        mvc.perform(get("/api/admin/chatlogs").header("Authorization","Bearer "+user)).andExpect(status().isForbidden());
        var withdrawn=reports.getFirst();
        mvc.perform(post("/api/chat/"+withdrawn.id+"/feedback").header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content("{\"feedback\":\"HELPFUL\"}")).andExpect(status().isOk());
        var visible=body(mvc.perform(get("/api/admin/chatlogs?pending=false").header("Authorization","Bearer "+admin)).andExpect(status().isOk()).andReturn());
        assertFalse(visible.toString().contains(withdrawn.id.toString()));
        mvc.perform(post("/api/admin/chatlogs/"+withdrawn.id+"/resolve").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"note\":\"Must no longer access withdrawn report\"}")).andExpect(status().isNotFound());
    }
    @Test void bulkDocumentPublicationKeepsValidationAndRollsBackIncompleteBatch() throws Exception {
        var first=doc();first.published=false;first=contents.saveAndFlush(first);
        var second=doc();second.published=false;
        var metadata=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(second.data);metadata.remove("fileKey");
        second.data=json.writeValueAsString(metadata);second=contents.saveAndFlush(second);
        var request=Map.of("rows",List.of(Map.of("id",first.id,"version",first.version),Map.of("id",second.id,"version",second.version)),"reviewed",true,"published",true);
        String payload=json.writeValueAsString(request),path="/api/admin/documents/publication-batch";
        mvc.perform(post(path).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isForbidden());
        mvc.perform(post(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isBadRequest());
        assertFalse(contents.findById(first.id).orElseThrow().published);
        metadata.put("fileKey","test-pdf");second.data=json.writeValueAsString(metadata);second=contents.saveAndFlush(second);
        payload=json.writeValueAsString(Map.of("rows",List.of(Map.of("id",first.id,"version",first.version),Map.of("id",second.id,"version",second.version)),"reviewed",true,"published",true));
        mvc.perform(post(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isOk());
        assertTrue(contents.findById(first.id).orElseThrow().published);assertTrue(contents.findById(second.id).orElseThrow().published);
        mvc.perform(post(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isConflict());
    }
    @Test void bulkUnitPublicationRequiresPublishedSourceAndPreservesTheWholeBatch() throws Exception {
        var published=doc();var draft=doc();draft.published=false;draft=contents.saveAndFlush(draft);
        var rows=new ArrayList<LegalUnit>();
        for(var source:List.of(published,draft)) {
            var unit=new LegalUnit();unit.unitId=source.externalId+"::TEST";unit.documentId=source.id;
            unit.data=json.writeValueAsString(Map.of("unit_id",unit.unitId,"doc_id",source.externalId,"so_hieu","TEST","unit_type","Dieu","text","TEST ONLY","order",1,"reviewed",false));
            rows.add(legalUnits.saveAndFlush(unit));
        }
        var request=Map.of("rows",rows.stream().map(unit->Map.of("id",unit.id,"version",unit.version)).toList(),"reviewed",true,"published",true);
        String payload=json.writeValueAsString(request),path="/api/admin/units/publication-batch";
        mvc.perform(post(path).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isForbidden());
        mvc.perform(post(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isBadRequest());
        for(var unit:rows) {var saved=legalUnits.findById(unit.id).orElseThrow();assertFalse(saved.published);assertFalse(json.readTree(saved.data).path("reviewed").asBoolean());}
        draft.published=true;contents.saveAndFlush(draft);
        mvc.perform(post(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isOk());
        for(var unit:rows) {var saved=legalUnits.findById(unit.id).orElseThrow();assertTrue(saved.published);assertTrue(json.readTree(saved.data).path("reviewed").asBoolean());}
        mvc.perform(post(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isConflict());
    }
    private UUID emptyQuestionSet(String name) {
        var input=json.createObjectNode().put("releaseCode","BULK-"+UUID.randomUUID().toString().substring(0,8))
            .put("releaseTitle","Test only").put("setCode","TEST").put("setName",name);
        return UUID.fromString(questionBank.createSet(input).path("id").asText());
    }
    @Test void bulkSetDeletionValidatesPermissionReferencesAndRollsBackAllChanges() throws Exception {
        UUID first=emptyQuestionSet("First"),second=emptyQuestionSet("Second"),used=emptyQuestionSet("Used");
        String path="/api/admin/questions/sets/deletion-batch";
        var fixture=new Content();fixture.kind="questions";fixture.externalId="BULK-"+UUID.randomUUID();
        fixture.data=json.writeValueAsString(Map.of("questionSetId",used));contents.saveAndFlush(fixture);
        String payload=json.writeValueAsString(Map.of("ids",List.of(first,second)));
        mvc.perform(delete(path).header("Authorization","Bearer "+user).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isForbidden());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content("{\"ids\":[]}")).andExpect(status().isBadRequest());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(first,first))))).andExpect(status().isBadRequest());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(first,used))))).andExpect(status().isBadRequest());
        UUID missing=new UUID(Long.MAX_VALUE,Long.MAX_VALUE);
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(first,missing))))).andExpect(status().isNotFound());
        assertTrue(questionBank.sets().stream().anyMatch(set->set.path("set_id").asText().equals(first.toString())));
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(payload)).andExpect(status().isOk());
        var remaining=questionBank.sets().stream().map(set->set.path("set_id").asText()).toList();
        assertFalse(remaining.contains(first.toString()));assertFalse(remaining.contains(second.toString()));assertTrue(remaining.contains(used.toString()));
    }
    @Test void bulkChapterAndRuleDeletionPreservesUsageAndExamHistory() throws Exception {
        UUID set=emptyQuestionSet("Chapters and rules"),missing=new UUID(Long.MAX_VALUE,Long.MAX_VALUE);
        for(int chapter:List.of(71,72)) questionBank.saveChapter(set,null,json.createObjectNode().put("chapter",chapter).put("name","Test "+chapter));
        var input=json.createObjectNode().put("setId",set.toString()).put("license","A1").put("validFrom","2000-01-01").put("validTo","2001-01-01")
            .put("totalQuestions",1).put("durationMinutes",1).put("minimumCorrect",1).put("criticalSlots",0).put("failOnCritical",true);
        input.putArray("quotas").addObject().put("chapter",73).put("question_quota",1);
        UUID usedRule=UUID.fromString(questionBank.createRule(input).path("rule_id").asText());
        var next=input.deepCopy().put("validFrom","2002-01-01").put("validTo","2003-01-01");
        UUID unusedRule=UUID.fromString(questionBank.createRule(next).path("rule_id").asText());
        var chapters=questionBank.chapters(set);
        UUID first=UUID.fromString(chapters.stream().filter(c->c.path("chapter").asInt()==71).findFirst().orElseThrow().path("topic_id").asText());
        UUID second=UUID.fromString(chapters.stream().filter(c->c.path("chapter").asInt()==72).findFirst().orElseThrow().path("topic_id").asText());
        UUID used=UUID.fromString(chapters.stream().filter(c->c.path("chapter").asInt()==73).findFirst().orElseThrow().path("topic_id").asText());
        String path="/api/admin/questions/sets/"+set+"/chapters/deletion-batch";
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(first,used))))).andExpect(status().isBadRequest());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(first,missing))))).andExpect(status().isNotFound());
        assertEquals(3,questionBank.chapters(set).size());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(first,second))))).andExpect(status().isOk());
        assertEquals(1,questionBank.chapters(set).size());
        var now=java.sql.Timestamp.from(java.time.Instant.now());
        jdbc.update("INSERT INTO exam_attempt(attempt_id,user_id,rule_id,set_id,started_at,expires_at) VALUES (?,?,?,?,?,?)",
            LearningCatalogRepository.binary(UUID.randomUUID()),LearningCatalogRepository.binary(userId),LearningCatalogRepository.binary(usedRule),LearningCatalogRepository.binary(set),now,now);
        path="/api/admin/questions/rules/deletion-batch";
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(unusedRule,usedRule))))).andExpect(status().isBadRequest());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(unusedRule,missing))))).andExpect(status().isNotFound());
        assertEquals(2,questionBank.rules(false).stream().filter(rule->rule.path("set_id").asText().equals(set.toString())).count());
        mvc.perform(delete(path).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("ids",List.of(unusedRule))))).andExpect(status().isOk());
        assertTrue(questionBank.rules(false).stream().anyMatch(rule->rule.path("rule_id").asText().equals(usedRule.toString())));
        assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM exam_attempt WHERE rule_id=?",Integer.class,LearningCatalogRepository.binary(usedRule)));
    }
    @Test void batchReviewCannotPublishMissingImageAndHistoryKeepsPreviousMetadata() throws Exception {
        var q=new Content(); q.kind="questions"; q.externalId="TEST-"+UUID.randomUUID(); q.data=json.writeValueAsString(Map.of("externalId",q.externalId,"text","Câu hỏi thử","chapter",1,"options",List.of("A","B"),"correctAnswer",0,"critical",false,"source","test-only","imageRequired",true)); q=contents.save(q);
        mvc.perform(post("/api/admin/questions/publication-batch").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",List.of(Map.of("id",q.id,"version",q.version)),"reviewed",true,"published",true)))).andExpect(status().isBadRequest());
        assertFalse(contents.findById(q.id).orElseThrow().published);
        var updated=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(q.data); updated.put("text","Câu đã sửa");
        mvc.perform(put("/api/admin/content/"+q.id).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("version",q.version,"data",updated)))).andExpect(status().isOk());
        assertTrue(history.findByContentIdOrderByChangedAtDesc(q.id).getFirst().data.contains("Câu hỏi thử"));
    }
}
