package vn.luatgt.repository;

import java.util.*;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.*;
import vn.luatgt.model.ChatMessage;

public interface ChatRepository extends JpaRepository<ChatMessage,UUID> {
    List<ChatMessage> findTop50ByOwnerIdOrderByCreatedAtDesc(UUID owner);
    Optional<ChatMessage> findByIdAndOwnerIdAndConversationIdIsNull(UUID id,UUID owner);
    @Query("select c from ChatMessage c where c.ownerId=:owner and (c.id=:root or c.conversationId=:root) and c.state<>'PROCESSING' order by c.createdAt desc,c.id desc")
    List<ChatMessage> recentTurns(UUID owner,UUID root,Pageable page);
    @Query("select c from ChatMessage c where c.ownerId=:owner and (c.id=:root or c.conversationId=:root) and (c.createdAt>:after or (c.createdAt=:after and c.id>:afterId)) order by c.createdAt,c.id")
    List<ChatMessage> turnsAfter(UUID owner,UUID root,java.time.Instant after,UUID afterId,Pageable page);
    @Modifying
    @org.springframework.transaction.annotation.Transactional
    @Query("update ChatMessage c set c.contextSummary=:summary,c.contextThrough=:next where c.id=:root and c.ownerId=:owner and ((:previous is null and c.contextThrough is null) or c.contextThrough=:previous)")
    int updateContext(UUID owner,UUID root,UUID previous,UUID next,String summary);
    @Query("select coalesce(c.conversationId,c.id) from ChatMessage c where c.ownerId=:owner group by coalesce(c.conversationId,c.id) order by max(c.createdAt) desc")
    List<UUID> recentConversationIds(UUID owner,Pageable page);
    @Query("select c from ChatMessage c where c.ownerId=:owner and (c.id in :ids or c.conversationId in :ids) order by c.createdAt desc,c.id desc")
    List<ChatMessage> conversationHistory(UUID owner,Collection<UUID> ids);
    @Query("select c from ChatMessage c where c.feedback in ('WRONG','NO_BASIS','OUTDATED') and (:pending=false or c.resolved=false) order by c.createdAt desc")
    List<ChatMessage> reported(@org.springframework.data.repository.query.Param("pending") boolean pending,org.springframework.data.domain.Pageable page);
    @Query("select count(c) from ChatMessage c where c.feedback in ('WRONG','NO_BASIS','OUTDATED') and (:pending=false or c.resolved=false)")
    long reportedCount(@org.springframework.data.repository.query.Param("pending") boolean pending);
    @Modifying
    @Query("update ChatMessage c set c.resolved=true,c.resolution=:note where c.id=:id and c.feedback in ('WRONG','NO_BASIS','OUTDATED')")
    int resolveReported(@org.springframework.data.repository.query.Param("id") UUID id,@org.springframework.data.repository.query.Param("note") String note);
}

