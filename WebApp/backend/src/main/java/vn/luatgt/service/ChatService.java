package vn.luatgt.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import vn.luatgt.dto.ChatRequest;
import vn.luatgt.exception.ApiErrors;
import vn.luatgt.integration.KagClient;
import vn.luatgt.model.ChatMessage;
import vn.luatgt.repository.ChatRepository;
import vn.luatgt.repository.ContentRepository;

@Service
public class ChatService {
    private final ChatRepository chats; private final ContentRepository contents; private final ContentService data; private final KagClient kag; private final RateLimit rate;
    private final KagSchema schema; private final LegalUnitService units;
    // ponytail: one monolith instance admits 8 concurrent streams; use a shared admission limit when running multiple replicas.
    private final Semaphore streams=new Semaphore(8);
    private final ConcurrentHashMap<UUID,Pending> pending=new ConcurrentHashMap<>();
    private static final class Pending {
        final ChatMessage chat; final FutureTask<JsonNode> call; final CountDownLatch drained=new CountDownLatch(1);
        boolean responseClosed;
        Pending(ChatMessage chat,Callable<JsonNode> call) {this.chat=chat;this.call=new FutureTask<>(call);}
    }
    public ChatService(ChatRepository chats,ContentRepository contents,ContentService data,KagClient kag,RateLimit rate,KagSchema schema,LegalUnitService units) { this.chats=chats; this.contents=contents; this.data=data; this.kag=kag; this.rate=rate; this.schema=schema; this.units=units; }
    private ChatMessage start(UUID owner,ChatRequest input) {
        var chat=new ChatMessage(); chat.ownerId=owner; chat.question=input.message(); chat.conversationId=input.conversationId(); chat.state="PROCESSING"; return chats.append(chat);
    }
    private record Context(ChatMessage root,List<ChatMessage> earlier,List<ChatMessage> recent) {}

    private Context context(UUID owner,UUID id) {
        if(id==null) return null;
        var root=chats.findByIdAndOwnerIdAndConversationIdIsNull(id,owner).filter(row->row.deletedAt==null).orElseThrow(ApiErrors::missing);
        var recent=new ArrayList<>(chats.recentTurns(owner,id,PageRequest.of(0,4)));
        Collections.reverse(recent);
        var cursor=root.contextThrough==null?root:chats.findById(root.contextThrough).orElseThrow();
        var candidates=new ArrayList<ChatMessage>();
        if(root.contextThrough==null) candidates.add(root);
        candidates.addAll(chats.turnsAfter(owner,id,cursor.createdAt,cursor.id,PageRequest.of(0,4)));
        var earlier=new ArrayList<ChatMessage>();
        for(var turn:candidates) {
            if(earlier.size()==4||turn.state.equals("PROCESSING")||recent.stream().anyMatch(item->item.id.equals(turn.id))) break;
            earlier.add(turn);
        }
        return new Context(root,earlier,recent);
    }

    private Map<String,String> contextTurn(ChatMessage turn) {
        return Map.of("question",clip(turn.question),"answer",
            ("ANSWERED".equals(turn.state)||"CLARIFY".equals(turn.state))&&turn.answer!=null?clip(turn.answer):"");
    }

    private String clip(String text) {
        if(text.length()<=1000) return text;
        return text.substring(0,Character.isHighSurrogate(text.charAt(999))?999:1000);
    }

    @org.springframework.beans.factory.annotation.Value("${app.kag-query-timeout-seconds:600}")
    private int queryTimeoutSeconds;

    private JsonNode answer(ChatMessage chat,Context context,long deadline) {
        var root=context==null?null:context.root();
        List<Map<String,String>> earlier=context==null?List.of():context.earlier().stream().map(this::contextTurn).toList();
        List<Map<String,String>> recent=context==null?List.of():context.recent().stream().map(this::contextTurn).toList();
        KagClient.ChatContext prepared;
        try {
            prepared=kag.chatContext(request(chat.ownerId,chat.question),root==null?"":Objects.toString(root.contextSummary,""),earlier,recent,deadline);
        } catch(RuntimeException e) {
            prepared=new KagClient.ChatContext(chat.question,"","","");
            earlier=List.of();
        }
        if(!earlier.isEmpty()) chats.updateContext(chat.ownerId,root.id,root.contextThrough,context.earlier().getLast().id,prepared.summary());
        if(!prepared.clarification().isEmpty())
            return data.mapper().createObjectNode().put("state","CLARIFY").put("clarification",prepared.clarification());
        if(!prepared.reply().isEmpty())
            return data.mapper().createObjectNode().put("state","ANSWERED").put("reply",prepared.reply());
        chat.understoodQuestion=prepared.question().equals(chat.question.strip())?null:prepared.question();
        Map<String,Object> query=new HashMap<>(request(chat.ownerId,prepared.question()));
        if(!prepared.searchQueries().isEmpty()) query.put("search_queries",prepared.searchQueries());
        return kag.query(query,chat.id,deadline);
    }
    private Map<String,Object> request(UUID owner,String question) { return Map.of("user_id",owner,"message",question,"context_id","","schema_contract",schema.identity()); }
    private void complete(ChatMessage chat,JsonNode response) {
        if(response!=null&&response.size()==2&&"ANSWERED".equals(response.path("state").asText())&&
                response.path("reply").isTextual()&&!response.path("reply").asText().isBlank()&&response.path("reply").asText().length()<=500) {
            chat.state="ANSWERED"; chat.mode="reply"; chat.answer=response.path("reply").asText(); chats.save(chat); return;
        }
        if(response!=null&&response.size()==2&&response.path("state").asText().equals("CLARIFY")&&
                response.path("clarification").isTextual()&&!response.path("clarification").asText().isBlank()&&
                response.path("clarification").asText().length()<=500) {
            chat.state="CLARIFY"; chat.answer=response.path("clarification").asText(); chats.save(chat); return;
        }
        if(response!=null&&response.isObject()&&"KAG_ABSTAINED".equals(response.path("state").asText())) {
            String reason=response.path("reason").asText();
            if(response.size()==1 || response.size()==2&&Set.of("no_source","out_of_scope","expired").contains(reason)) {
                chat.state="KAG_ABSTAINED"; chat.mode=reason.isEmpty()?null:reason; chats.save(chat); return;
            }
        }
        if(response==null||!response.path("answer").isTextual()||response.path("answer").asText().isBlank()||response.path("answer").asText().length()>20000||!response.path("citations").isArray()||response.path("citations").isEmpty()||response.path("citations").size()>20)
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"KAG trả về câu trả lời thiếu căn cứ");
        for(var citation:response.path("citations")) {
            if(response.path("contract_version").asText().equals("graph-chat-v1")) {
                if(!citation.path("source").path("contract_version").asText().equals("graph-source-v1")||
                    !citation.path("source").path("text").equals(citation.path("quote")))
                    throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"Trích dẫn không khớp bản nguồn của đồ thị");
                continue;
            }
            if(!citation.path("doc_id").isTextual()||!citation.path("unit_id").isTextual()||citation.path("unit_id").asText().isBlank()) throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"Trích dẫn KAG không hợp lệ");
            var source=contents.findByKindAndExternalId("documents",citation.path("doc_id").asText());
            if(source.isEmpty()||!source.get().published||!data.isEffective(source.get())) throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"KAG dẫn văn bản chưa xuất bản hoặc hết hiệu lực");
            if(!citation.path("quote").isTextual()||!units.citation(citation.path("doc_id").asText(),citation.path("unit_id").asText(),citation.path("quote").asText())) throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"KAG dẫn unit chưa xuất bản, sai văn bản hoặc trích đoạn không có trong nguồn");
        }
        chat.answer=response.path("answer").asText(); chat.citations=data.write(response.path("citations")); chat.state="ANSWERED";
        String mode=response.path("mode").asText();
        if(Set.of("answer","cases","related").contains(mode)) chat.mode=mode;
        chats.save(chat);
    }
    private Map<String,Object> view(ChatMessage c) {
        var result=new LinkedHashMap<String,Object>(Map.of("id",c.id,"conversationId",c.conversationId==null?c.id:c.conversationId,
            "conversationTitle",Objects.toString(c.conversationTitle,""),
            "question",c.question,"answer",c.answer==null?"":c.answer,"citations",parse(c.citations),"state",c.state,"createdAt",c.createdAt));
        if(c.mode!=null) result.put(Set.of("reply","answer","cases","related").contains(c.mode)?"mode":"reason",c.mode);
        if(c.understoodQuestion!=null&&!"PROCESSING".equals(c.state)) result.put("understoodQuestion",c.understoodQuestion);
        if("UNAVAILABLE".equals(c.state)) result.put("reason","technical");
        return result;
    }
    private JsonNode parse(String value) { try { return data.mapper().readTree(value); } catch(Exception e) { throw new IllegalStateException(e); } }
    public StreamingResponseBody progress(UUID owner,ChatRequest input) {
        if(!streams.tryAcquire()) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Đang có nhiều truy vấn, vui lòng thử lại");
        long deadline=System.currentTimeMillis()+1000L*queryTimeoutSeconds;
        Pending job;
        try {
            rate.check("chat:"+owner,20,60);
            var context=context(owner,input.conversationId()); var chat=start(owner,input);
            job=new Pending(chat,()->answer(chat,context,deadline)); pending.put(chat.id,job);
        } catch(RuntimeException e) {streams.release();throw e;}
        return output -> {
            Thread.startVirtualThread(()->{
                try {job.call.run();}
                finally {job.drained.countDown();release(job);}
            });
            try {
                emit(output,"started",view(job.chat));
                while(true) {
                    try {
                        var result=job.call.get(1,TimeUnit.SECONDS);
                        synchronized(job) {if(job.chat.state.equals("PROCESSING")) complete(job.chat,result);}
                        break;
                    } catch(TimeoutException e) {
                        output.write(": waiting\n\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));output.flush();
                    }
                }
                synchronized(job) {emit(output,"done",view(job.chat));}
            } catch(CancellationException e) {
                synchronized(job) {emit(output,job.chat.state.equals("CANCELLED")?"done":"error",view(job.chat));}
            } catch(UncheckedIOException e) {
                synchronized(job) {unavailable(job);job.call.cancel(true);}
                throw e;
            } catch(ExecutionException|RuntimeException e) {
                synchronized(job) {unavailable(job);emit(output,job.chat.state.equals("CANCELLED")?"done":"error",view(job.chat));}
            } catch(InterruptedException e) {
                Thread.currentThread().interrupt();
                synchronized(job) {unavailable(job);job.call.cancel(true);}
            } catch(IOException e) {
                synchronized(job) {unavailable(job);job.call.cancel(true);}
                throw new UncheckedIOException(e);
            } finally {
                synchronized(job) {job.responseClosed=true;release(job);}
            }
        };
    }
    private void unavailable(Pending job) {
        if(job.chat.state.equals("PROCESSING")) {job.chat.state="UNAVAILABLE";chats.save(job.chat);}
    }
    private void release(Pending job) {
        synchronized(job) {
            // Cancellation completes a Future before its interrupted HTTP worker has actually drained.
            if(job.responseClosed&&job.drained.getCount()==0&&pending.remove(job.chat.id,job)) streams.release();
        }
    }
    public Map<String,Object> stop(UUID owner,UUID id) {
        rate.check("chat-stop:"+owner,60,60);
        var job=pending.get(id);
        if(job==null) {
            var chat=chats.findById(id).filter(row->row.ownerId.equals(owner)).orElseThrow(ApiErrors::missing);
            if(chat.state.equals("PROCESSING")) throw new ResponseStatusException(HttpStatus.CONFLICT,"Chưa xác nhận được lượt đang xử lý. Tải lại lịch sử để kiểm tra.");
            return view(chat);
        }
        synchronized(job) {
            if(!job.chat.ownerId.equals(owner)) throw ApiErrors.missing();
            if(job.chat.state.equals("PROCESSING")) {
                job.chat.state="CANCELLED";job.chat.answer=null;job.chat.citations="[]";chats.save(job.chat);
                job.call.cancel(true);
            }
            return view(job.chat);
        }
    }
    private void emit(OutputStream output,String event,Object value) {
        try { output.write(("event: "+event+"\ndata: "+data.mapper().writeValueAsString(value)+"\n\n").getBytes(java.nio.charset.StandardCharsets.UTF_8)); output.flush(); }
        catch(IOException e) { throw new UncheckedIOException(e); }
    }
    public record HistoryPage(List<Map<String,Object>> rows,String nextCursor) {}
    @org.springframework.transaction.annotation.Transactional(readOnly=true)
    public HistoryPage history(UUID owner,String cursor,UUID selected) {
        if(selected!=null) chats.findByIdAndOwnerIdAndConversationIdIsNull(selected,owner)
            .filter(row->row.deletedAt==null).orElseThrow(ApiErrors::missing);
        var before=java.time.Instant.now();
        var beforeId=new UUID(0,0);
        if(cursor!=null) {
            try {
                var parts=cursor.split("\\|",-1);
                if(parts.length!=2) throw new IllegalArgumentException();
                before=java.time.Instant.parse(parts[0]);
                beforeId=UUID.fromString(parts[1]);
            } catch(IllegalArgumentException|java.time.format.DateTimeParseException e) {
                throw ApiErrors.bad("Mốc lịch sử không hợp lệ. Hãy tải lại lịch sử.");
            }
        }
        var ids=chats.recentConversationIds(owner,before,beforeId,PageRequest.of(0,51));
        boolean more=ids.size()>50;
        ids=ids.subList(0,Math.min(50,ids.size()));
        if(ids.isEmpty()&&selected==null) return new HistoryPage(List.of(),"");
        var lastId=ids.isEmpty()?null:ids.get(ids.size()-1);
        if(selected!=null&&!ids.contains(selected)) {ids=new ArrayList<>(ids);ids.add(selected);}
        var rows=chats.conversationHistory(owner,ids);
        String next=more?rows.stream().filter(row->lastId.equals(row.conversationId==null?row.id:row.conversationId))
            .findFirst().map(row->row.createdAt+"|"+lastId).orElse(""):"";
        return new HistoryPage(rows.stream().map(this::view).toList(),next);
    }
    @org.springframework.transaction.annotation.Transactional
    public void deleteConversation(UUID owner,UUID id) {
        var root=chats.lockConversation(owner,id).orElseThrow(ApiErrors::missing);
        if(root.deletedAt!=null) return;
        if(chats.processingTurns(owner,id)>0)
            throw new ResponseStatusException(HttpStatus.CONFLICT,"Cuộc trò chuyện đang trả lời. Hãy dừng và thử xóa lại.");
        chats.hideConversation(owner,id,java.time.Instant.now());
    }
    @org.springframework.transaction.annotation.Transactional
    public void renameConversation(UUID owner,UUID id,String title) {
        var root=chats.lockConversation(owner,id).filter(row->row.deletedAt==null).orElseThrow(ApiErrors::missing);
        String normalized=title.strip();
        if(normalized.isBlank()||normalized.length()>200) throw ApiErrors.bad("Tên cuộc trò chuyện cần từ 1 đến 200 ký tự.");
        chats.renameConversation(owner,root.id,normalized);
    }
}
