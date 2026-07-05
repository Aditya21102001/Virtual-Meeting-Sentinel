package com.agmsentinel.repository;

import com.agmsentinel.model.AppUser;
import com.agmsentinel.model.WebAuthnCredential;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface WebAuthnCredentialRepository extends JpaRepository<WebAuthnCredential, UUID> {
    List<WebAuthnCredential> findByUser(AppUser user);
    Optional<WebAuthnCredential> findByCredentialId(String credentialId);
    long countByUser(AppUser user);
}
