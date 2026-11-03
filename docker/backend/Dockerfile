FROM maven:3.9.16-eclipse-temurin-21 AS build
WORKDIR /build/WebApp/backend
COPY WebApp/backend/pom.xml .
RUN mvn -B -q dependency:go-offline
COPY WebApp/backend/src src
COPY kag/schema/schema_contract.json kag/schema/VietRoadTraffic.schema /build/kag/schema/
ENV TZ=Asia/Saigon
RUN useradd --create-home --uid 10002 builder && mv /root/.m2 /home/builder/.m2 && chown -R builder:builder /build /home/builder/.m2
USER 10002
RUN mvn -B -q package -Dmaven.test.skip=true

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN useradd --system --uid 10001 app
COPY --from=build /build/WebApp/backend/target/backend-0.1.0.jar app.jar
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
