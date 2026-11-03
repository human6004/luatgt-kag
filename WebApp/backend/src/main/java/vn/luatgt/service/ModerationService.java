package vn.luatgt.service;
import vn.luatgt.dto.*;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.model.*;
import vn.luatgt.repository.*;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
@Service
public class ModerationService {
    private final ChatRepository chats; private final ContentRepository contents; private final AccountRepository accounts;
    private final ExamRepository exams; private final ContentService data;
    private final LearningCatalogRepository bank;
    public ModerationService(ChatRepository chats,ContentRepository contents,AccountRepository accounts,ExamRepository exams,ContentService data,LearningCatalogRepository bank) {
        this.chats=chats; this.contents=contents; this.accounts=accounts; this.exams=exams; this.data=data;this.bank=bank;
    }
    private Map<String,Object> view(ChatMessage c) {
        var result=new LinkedHashMap<String,Object>(); result.put("id",c.id); result.put("ownerId",c.ownerId); result.put("question",c.question);
        result.put("answer",c.answer); result.put("state",c.state); result.put("feedback",c.feedback); result.put("note",c.feedbackNote);
        result.put("resolved",c.resolved); result.put("resolution",c.resolution); result.put("createdAt",c.createdAt); return result;
    }
    public List<Map<String,Object>> logs(boolean pending) { return chats.reported(pending,org.springframework.data.domain.PageRequest.of(0,100)).stream().map(this::view).toList(); }
    @Transactional public void feedback(UUID id,UUID owner,FeedbackRequest request) {
        var chat=chats.findById(id).filter(c -> c.ownerId.equals(owner)).orElseThrow(ApiErrors::missing);
        chat.feedback=request.feedback(); chat.feedbackNote=request.note(); chat.resolved=false; chat.resolution=null; chats.save(chat);
    }
    @Transactional public void resolve(UUID id,ResolutionRequest request) {
        if(chats.resolveReported(id,request.note())==0) throw ApiErrors.missing();
    }
    public Map<String,Object> report() {
        var summary=bank.examSummary();
        return Map.of("users",accounts.count(),"questions",contents.countByKind("questions"),"publishedQuestions",contents.countByKindAndPublishedTrue("questions"),"documents",contents.countByKind("documents"),
            "signs",contents.countByKind("signs"),"exams",exams.count()+summary.path("total").asLong(),"passedExams",exams.countByPassedTrue()+summary.path("passed").asLong(),"chatMessages",chats.reportedCount(false),"pendingChats",chats.reportedCount(true));
    }
}
