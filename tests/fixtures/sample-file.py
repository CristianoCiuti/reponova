"""
User service module.
Provides user management functionality.
"""

from sqlalchemy.orm import Session
from project_core.db.connection import connect_database, get_session
from project_core.models.user import User


@log_call
def get_user_by_id(session: Session, user_id: int) -> User:
    """Retrieves a user by primary key."""
    connection = connect_database()
    result = session.query(User).filter(User.id == user_id).first()
    validate_user(result)
    return result


def update_user(session: Session, user_id: int, data: dict) -> User:
    """Updates user fields and persists changes."""
    user = get_user_by_id(session, user_id)
    for key, value in data.items():
        setattr(user, key, value)
    session.commit()
    return user


class UserService(BaseService):
    """Service layer for user operations."""

    def create(self, data: dict) -> User:
        """Create a new user."""
        validated = validate_user(data)
        return self.repo.save(validated)

    def delete(self, user_id: int) -> None:
        """Delete a user by ID."""
        user = get_user_by_id(self.session, user_id)
        self.repo.delete(user)

    def list_all(self, filters: dict = None) -> list:
        """List all users with optional filtering."""
        query = self.session.query(User)
        if filters:
            for key, value in filters.items():
                query = query.filter(getattr(User, key) == value)
        return query.all()
