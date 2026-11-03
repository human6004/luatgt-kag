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
    @Test void batchReviewCannotPublishMissingImageAndHistoryKeepsPreviousMetadata() throws Exception {
        var q=new Content(); q.kind="questions"; q.externalId="TEST-"+UUID.randomUUID(); q.data=json.writeValueAsString(Map.of("externalId",q.externalId,"text","Câu hỏi thử","chapter",1,"options",List.of("A","B"),"correctAnswer",0,"critical",false,"source","test-only","imageRequired",true)); q=contents.save(q);
        mvc.perform(post("/api/admin/questions/publication-batch").header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("rows",List.of(Map.of("id",q.id,"version",q.version)),"reviewed",true,"published",true)))).andExpect(status().isBadRequest());
        assertFalse(contents.findById(q.id).orElseThrow().published);
        var updated=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(q.data); updated.put("text","Câu đã sửa");
        mvc.perform(put("/api/admin/content/"+q.id).header("Authorization","Bearer "+admin).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("version",q.version,"data",updated)))).andExpect(status().isOk());
        assertTrue(history.findByContentIdOrderByChangedAtDesc(q.id).getFirst().data.contains("Câu hỏi thử"));
    }
}
