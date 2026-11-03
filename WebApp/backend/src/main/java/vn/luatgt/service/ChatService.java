package vn.luatgt.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
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
        rate.check("chat:"+owner,20,60); var chat=new ChatMessage(); chat.ownerId=owner; chat.question=input.message(); chat.state="PROCESSING"; return chats.save(chat);
    }
    private Map<String,Object> request(UUID owner,ChatRequest input) { return Map.of("user_id",owner,"message",input.message(),"context_id",input.contextId()==null?"":input.contextId(),"schema_contract",schema.identity()); }
    private void complete(ChatMessage chat,JsonNode response) {
        if(response!=null&&response.isObject()&&response.size()==1&&response.path("state").isTextual()&&response.path("state").asText().equals("KAG_ABSTAINED")) {
            chat.state="KAG_ABSTAINED"; chats.save(chat); return;
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
        chat.answer=response.path("answer").asText(); chat.citations=data.write(response.path("citations")); chat.state="ANSWERED"; chats.save(chat);
    }
    private Map<String,Object> view(ChatMessage c) {
        return Map.of("id",c.id,"question",c.question,"answer",c.answer==null?"":c.answer,"citations",parse(c.citations),"state",c.state,"createdAt",c.createdAt);
    }
    private JsonNode parse(String value) { try { return data.mapper().readTree(value); } catch(Exception e) { throw new IllegalStateException(e); } }
    public Map<String,Object> ask(UUID owner,ChatRequest input) {
        var chat=start(owner,input);
        try { complete(chat,kag.query(request(owner,input),chat.id)); return view(chat); }
        catch(RuntimeException e) { chat.state="UNAVAILABLE"; chats.save(chat); throw e; }
    }
    public StreamingResponseBody stream(UUID owner,ChatRequest input) {
        if(!streams.tryAcquire()) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Đang có nhiều truy vấn, vui lòng thử lại");
        ChatMessage chat;
        try { chat=start(owner,input); } catch(RuntimeException e) { streams.release(); throw e; }
        return output -> {
            try {
                kag.stream(request(owner,input),(event,payload) -> {
                    if(event.equals("done")) { complete(chat,payload); emit(output,"done",view(chat)); }
                    else {
                        if(!payload.path("text").isTextual()||payload.path("text").asText().length()>4000) throw ApiErrors.bad("Delta không hợp lệ");
                        emit(output,"delta",Map.of("text",payload.path("text").asText()));
                    }
                });
            } catch(RuntimeException e) {
                chat.state="UNAVAILABLE"; chats.save(chat);
                emit(output,"error",Map.of("message","Dịch vụ KAG chưa khả dụng hoặc câu trả lời chưa đủ căn cứ","id",chat.id));
            } finally { streams.release(); }
        };
    }
    public StreamingResponseBody progress(UUID owner,ChatRequest input) {
        if(!streams.tryAcquire()) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Đang có nhiều truy vấn, vui lòng thử lại");
        Pending job;
        try {
            var chat=start(owner,input); var payload=request(owner,input);
            job=new Pending(chat,()->kag.query(payload,chat.id)); pending.put(chat.id,job);
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
    public List<Map<String,Object>> history(UUID owner) { return chats.findTop50ByOwnerIdOrderByCreatedAtDesc(owner).stream().map(this::view).toList(); }
}
