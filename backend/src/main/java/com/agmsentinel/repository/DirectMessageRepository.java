package com.agmsentinel.repository;

import com.agmsentinel.model.DirectMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface DirectMessageRepository extends JpaRepository<DirectMessage, UUID> {

    /** Full thread between two users (either direction), oldest first. */
    @Query("""
           select m from DirectMessage m
           where (m.sender = :a and m.recipient = :b)
              or (m.sender = :b and m.recipient = :a)
           order by m.sentAt asc
           """)
    List<DirectMessage> conversation(@Param("a") String a, @Param("b") String b);

    /** Unread messages sent FROM `peer` TO `me` — drives the per-contact unread badge. */
    long countBySenderAndRecipientAndReadAtIsNull(String peer, String me);

    /** Every message involving `me` (either direction), newest first — to derive the contact list. */
    @Query("""
           select m from DirectMessage m
           where m.sender = :me or m.recipient = :me
           order by m.sentAt desc
           """)
    List<DirectMessage> involving(@Param("me") String me);
}
