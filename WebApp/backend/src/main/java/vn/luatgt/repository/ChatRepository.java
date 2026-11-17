package vn.luatgt.repository;

import java.util.*;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.*;
import vn.luatgt.model.ChatMessage;

public interface ChatRepository extends JpaRepository<ChatMessage,UUID> {
    List<ChatMessage> findTop50ByOwnerIdOrderByCreatedAtDesc(UUID owner);
    Optional<ChatMessage> findByIdAndOwnerIdAndConversationIdIsNull(UUID id,UUID owner);
    @Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from ChatMessage c where c.id=:root and c.ownerId=:owner and c.conversationId is null")
    Optional<ChatMessage> lockConversation(UUID owner,UUID root);
    @org.springframework.transaction.annotation.Transactional
    default ChatMessage append(ChatMessage message) {
        if(message.conversationId!=null) {
            var root=lockConversation(message.ownerId,message.conversationId).orElseThrow(vn.luatgt.exception.ApiErrors::missing);
            if(root.deletedAt!=null) throw vn.luatgt.exception.ApiErrors.missing();
        }
        return saveAndFlush(message);
    }
    @Query("select count(c) from ChatMessage c where c.ownerId=:owner and (c.id=:root or c.conversationId=:root) and c.state='PROCESSING'")
    long processingTurns(UUID owner,UUID root);
    @Modifying
    @Query("update ChatMessage c set c.deletedAt=:deletedAt where c.id=:root and c.ownerId=:owner and c.deletedAt is null")
    int hideConversation(UUID owner,UUID root,java.time.Instant deletedAt);
    @Modifying
    @Query("update ChatMessage c set c.conversationTitle=:title where c.id=:root and c.ownerId=:owner and c.deletedAt is null")
    int renameConversation(UUID owner,UUID root,String title);
    @Query("select c from ChatMessage c where c.ownerId=:owner and (c.id=:root or c.conversationId=:root) and c.state<>'PROCESSING' order by c.createdAt desc,c.id desc")
    List<ChatMessage> recentTurns(UUID owner,UUID root,Pageable page);
    @Query("select c from ChatMessage c where c.ownerId=:owner and (c.id=:root or c.conversationId=:root) and (c.createdAt>:after or (c.createdAt=:after and c.id>:afterId)) order by c.createdAt,c.id")
    List<ChatMessage> turnsAfter(UUID owner,UUID root,java.time.Instant after,UUID afterId,Pageable page);
    @Modifying
    @org.springframework.transaction.annotation.Transactional
    @Query("update ChatMessage c set c.contextSummary=:summary,c.contextThrough=:next where c.id=:root and c.ownerId=:owner and ((:previous is null and c.contextThrough is null) or c.contextThrough=:previous)")
    int updateContext(UUID owner,UUID root,UUID previous,UUID next,String summary);
    @Query("select r.id from ChatMessage r join ChatMessage c on c.ownerId=r.ownerId and (c.id=r.id or c.conversationId=r.id) where r.ownerId=:owner and r.conversationId is null and r.deletedAt is null group by r.id having max(c.createdAt)<:before or (max(c.createdAt)=:before and r.id<:beforeId) order by max(c.createdAt) desc,r.id desc")
    List<UUID> recentConversationIds(UUID owner,java.time.Instant before,UUID beforeId,Pageable page);
    @Query("select c from ChatMessage c where c.ownerId=:owner and (c.id in :ids or c.conversationId in :ids) and not exists (select r.id from ChatMessage r where r.id=coalesce(c.conversationId,c.id) and r.deletedAt is not null) order by c.createdAt desc,c.id desc")
    List<ChatMessage> conversationHistory(UUID owner,Collection<UUID> ids);
    @Query("select c from ChatMessage c where c.feedback in ('WRONG','NO_BASIS','OUTDATED') and (:pending=false or c.resolved=false) order by c.createdAt desc")
    List<ChatMessage> reported(@org.springframework.data.repository.query.Param("pending") boolean pending,org.springframework.data.domain.Pageable page);
    @Query("select count(c) from ChatMessage c where c.feedback in ('WRONG','NO_BASIS','OUTDATED') and (:pending=false or c.resolved=false)")
    long reportedCount(@org.springframework.data.repository.query.Param("pending") boolean pending);
    @Modifying
    @Query("update ChatMessage c set c.resolved=true,c.resolution=:note where c.id=:id and c.feedback in ('WRONG','NO_BASIS','OUTDATED')")
    int resolveReported(@org.springframework.data.repository.query.Param("id") UUID id,@org.springframework.data.repository.query.Param("note") String note);
}

