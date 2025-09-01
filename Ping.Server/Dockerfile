# Build
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY Ping.Server/Ping.Server.csproj Ping.Server/
RUN dotnet restore Ping.Server/Ping.Server.csproj
COPY Ping.Server/. Ping.Server/
RUN dotnet publish Ping.Server/Ping.Server.csproj -c Release -o /app/out

# Run
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080
COPY --from=build /app/out ./
ENTRYPOINT ["dotnet", "Ping.Server.dll"]