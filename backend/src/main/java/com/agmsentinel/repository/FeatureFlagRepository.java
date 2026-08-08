package com.agmsentinel.repository;

import com.agmsentinel.model.FeatureFlag;
import org.springframework.data.jpa.repository.JpaRepository;

public interface FeatureFlagRepository extends JpaRepository<FeatureFlag, String> {
}
